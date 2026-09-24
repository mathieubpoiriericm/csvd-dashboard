"""Open Targets verification of the curated trial mechanisms.

This does not replace ``clinical_trials.mechanism_of_action``. Measured against
the live API on 2026-08-31, 6 of the 11 drugs in the curated table resolve, 5
carry a mechanism, and **every one of those 5 agrees with the curator's
parenthetical** -- Cilostazol/PDE3A, Colchicine/tubulin, Exenatide/GLP1R,
Isosorbide mononitrate/soluble guanylate cyclase, Tranexamic acid/plasminogen.
The 5 that do not resolve are unregistered agents, a peptide preparation and a
trade-named complex ChEMBL does not carry; that is a coverage limit of the
reference database, not an error in the curated column. The curator strings are
also richer -- they carry a clinical class ("Antiplatelet, vasodilator") that
an action type does not.

So Open Targets is recorded beside the curated value, ``resolved`` flag
included, rather than over it.

**Where a divergence actually shows up.** ``trial_drug_annotations`` is read by
no export, no TypeScript module and no island, so the stored comparison reaches
no committed file and no page -- only SQL. `_log_mechanism_comparison` writes
each resolved drug's two mechanisms into the run log side by side so a curator
meets the disagreement without querying the table. It does not judge agreement,
and deliberately: the curator records a clinical class ("Vasodilator (nitrate)")
where Open Targets records a target action ("Soluble guanylate cyclase
activator"), and those agree while sharing no word. Every textual rule tried
against the eleven curated drugs flagged at least one of the five agreeing
pairs, so the reading is left to the reader.

``resolved=False`` and a failure are different things and are counted
differently: the first is a drug the API answered about and does not carry,
the second is a transport error, which ``fetch_drug_mechanism`` reports as
``None``. Counting the five expected absences as failures would mark every
healthy run failed.
"""

import logging
import re
from collections.abc import Iterable
from typing import Any, Final

from pipeline.annotations import DrugAnnotationRow
from pipeline.cache_utils import SyncResult, make_log_progress, run_batched_fetch
from pipeline.config import PipelineConfig
from pipeline.opentargets_fetch import (
    _get_opentargets_semaphore,
    fetch_data_version,
    graphql,
)

logger = logging.getLogger(__name__)

# "Mivelsiran (ALN-APP)" -> "Mivelsiran". The development code in parentheses
# is what ChEMBL does not index; stripping it is the difference between 6 hits
# and 4. Anchored at the end and non-greedy from the last "(": a global strip
# turns "Nimodipine (extended release)" into a search for "Nimodipine" -- fine
# -- but also turns a bare "(ALN-APP)" into a search for the empty string.
_TRADE_SUFFIX: Final[re.Pattern[str]] = re.compile(r"\s*\([^()]*\)\s*$")

_DRUG_QUERY: Final[str] = """
query Drug($q: String!) {
  search(queryString: $q, entityNames: ["drug"], page: {index: 0, size: 10}) {
    hits {
      object {
        ... on Drug {
          id
          name
          mechanismsOfAction {
            rows { actionType mechanismOfAction targets { approvedSymbol } }
          }
        }
      }
    }
  }
}
"""


def strip_trade_suffix(name: str) -> str:
    """Drop a parenthesised development code or trade name."""
    return _TRADE_SUFFIX.sub("", name).strip()


async def get_trial_drugs() -> list[tuple[str, str | None]]:
    """Each trial drug once, with the mechanism the curator recorded for it.

    The curated string comes back beside the name so the verification can be
    written down next to what it verifies; ``sync_trial_drug_annotations``
    logs the pair.
    """
    from pipeline.database import Database

    async with Database.connection() as conn:
        # No IS NOT NULL guard on drug: clinical_trials.drug is VARCHAR(255)
        # NOT NULL (001_baseline_schema.py:47). One row per drug, so a drug in
        # several trials is still searched once; MIN keeps that row -- and so
        # the run -- reproducible if two of them spell the mechanism
        # differently, and the log names the string that was compared. ORDER BY
        # is what makes the run reproducible.
        rows = await conn.fetch(
            """
            SELECT drug, MIN(mechanism_of_action) AS mechanism_of_action
            FROM clinical_trials
            GROUP BY drug
            ORDER BY drug
            """
        )
        return [(row["drug"], row["mechanism_of_action"]) for row in rows]



def _unresolved(drug: str, data_version: str | None) -> DrugAnnotationRow:
    """The row for a drug the reference database answered about and lacks."""
    return DrugAnnotationRow(
        drug=drug,
        chembl_id=None,
        action_type=None,
        mechanism_of_action=None,
        target_symbols=None,
        source_version=data_version,
        resolved=False,
    )


def _matching_hit(
    hits: list[dict[str, Any]], query: str
) -> dict[str, Any] | None:
    """The hit whose own name is the one we searched for, or None.

    Open Targets' search is fuzzy and returns something for almost anything:
    'Placebo' comes back as NICOTINE and 'Minocyclin' as MINOCYCLINE
    HYDROCHLORIDE. Taking hits[0] on trust would record a mechanism for a drug
    nobody asked about, against a curated column, which is worse than
    recording nothing. ``resolve_target`` applies the same rule to genes.
    """
    wanted = query.strip().casefold()
    for hit in hits:
        obj = hit.get("object") or {}
        if str(obj.get("name") or "").strip().casefold() == wanted:
            return obj
    return None


def _joined(values: Iterable[str]) -> str | None:
    """De-duplicated, sorted, comma-joined -- or None when there is nothing."""
    unique = sorted({value.strip() for value in values if value.strip()})
    return ", ".join(unique) or None


async def fetch_drug_mechanism(
    drug: str,
    data_version: str | None,
    config: PipelineConfig | None = None,
) -> DrugAnnotationRow | None:
    """Look one drug up in Open Targets. Never raises.

    Two different outcomes, deliberately distinguished. A drug the API answered
    about and does not carry is a row with ``resolved=False`` -- 5 of the 11
    curated drugs are legitimately absent from ChEMBL, and that is data. A
    transport failure returns ``None``, as every other fetcher in this plan
    does, so a 500 is never written as "ChEMBL does not have this drug".
    """
    query = strip_trade_suffix(drug)
    if not query:
        logger.info(f"Nothing left of {drug!r} to search for")
        return _unresolved(drug, data_version)

    # Through the shared semaphore, like every other Open Targets call. This
    # module reached graphql() directly, so PIPELINE_OPENTARGETS_RATE_LIMIT was
    # inert here and the httpx pool's 10 was the only bound.
    async with _get_opentargets_semaphore(config):
        data = await graphql(_DRUG_QUERY, {"q": query})
    if data is None:
        return None

    hits = ((data.get("search") or {}).get("hits")) or []
    if not hits:
        logger.info(f"Open Targets has no drug record for {drug!r}")
        return _unresolved(drug, data_version)

    obj = _matching_hit(hits, query)
    if obj is None:
        logger.info(
            f"Open Targets returned no drug named {query!r} for {drug!r}; "
            "the search is fuzzy, so a near-miss is not a match"
        )
        return _unresolved(drug, data_version)

    rows = ((obj.get("mechanismsOfAction") or {}).get("rows")) or []
    # Every mechanism, not rows[0]: a drug can act through several, and the
    # API does not rank them. Nimodipine's first row is a mineralocorticoid
    # receptor antagonist, which is not what the trial is testing.
    action_types = _joined(str(r.get("actionType") or "") for r in rows)
    mechanisms = _joined(str(r.get("mechanismOfAction") or "") for r in rows)
    targets = _joined(
        str(t.get("approvedSymbol") or "")
        for r in rows
        for t in (r.get("targets") or [])
    )

    return DrugAnnotationRow(
        drug=drug,
        chembl_id=str(obj.get("id") or "") or None,
        action_type=action_types,
        mechanism_of_action=mechanisms,
        target_symbols=targets,
        source_version=data_version,
        resolved=True,
    )


def _log_mechanism_comparison(
    rows: list[DrugAnnotationRow], curated: dict[str, str | None]
) -> None:
    """Write each resolved drug's two mechanisms into the run log, side by side.

    The verification lands in ``trial_drug_annotations``, which no export, no
    TypeScript module and no island reads, so a curator who does not query the
    table sees nothing of it. This is the cheapest place to put it in front of
    one: the log the refresh already writes.

    Deliberately not a machine verdict. Agreement here is a pharmacological
    judgement, not a string comparison -- the curator records a clinical class
    ("Vasodilator (nitrate)") where Open Targets records a target action
    ("Soluble guanylate cyclase activator"), and those two agree while sharing
    no word. Every textual rule tried on the eleven curated drugs flags at
    least one pair the module has measured to agree, and a "divergence" that is
    not one is worse than no flag at all.
    """
    for row in rows:
        if not row.resolved:
            continue
        logger.info(
            f"Mechanism check -- {row.drug}: curated "
            f"{curated.get(row.drug) or '(none recorded)'!r}; Open Targets "
            f"{row.action_type or '(no action type)'} / "
            f"{row.mechanism_of_action or '(no mechanism)'} "
            f"[{row.target_symbols or 'no target'}]"
        )


async def sync_trial_drug_annotations(
    config: PipelineConfig | None = None,
) -> SyncResult:
    """Fetch and store an Open Targets mechanism for every curated trial drug."""
    from pipeline.database import upsert_drug_annotations

    curated = dict(await get_trial_drugs())
    if not curated:
        return SyncResult()

    drugs = list(curated)
    data_version = await fetch_data_version()
    results = await run_batched_fetch(
        drugs,
        lambda drug: fetch_drug_mechanism(drug, data_version, config=config),
        make_log_progress("Open Targets drugs"),
    )

    rows = [row for row in results if row is not None]
    errors = [
        f"Open Targets drug lookup failed: {drug}"
        for drug, row in zip(drugs, results, strict=True)
        if row is None
    ]

    _log_mechanism_comparison(rows, curated)

    # Reported, not counted as a failure: five of eleven are expected to be
    # absent from ChEMBL on every healthy run.
    unresolved = [r.drug for r in rows if not r.resolved]
    if unresolved:
        logger.info(
            f"{len(unresolved)} of {len(rows)} trial drugs are not in ChEMBL: "
            f"{', '.join(unresolved)}"
        )

    await upsert_drug_annotations(rows)

    return SyncResult(
        fetched=len(rows),
        failed=len(errors),
        errors=errors,
    )
