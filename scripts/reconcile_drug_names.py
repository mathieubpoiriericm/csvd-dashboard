"""Report what RxNorm and ChEMBL call each stored trial drug. Writes nothing.

The same shape as `scripts/reconcile_omim.py`: the stored column is a
scientific judgement, so a registry is read *beside* it and every
disagreement printed here needs a human. `pipeline/opentargets_drugs.py`
records ChEMBL mechanisms the same way, for the same reason.

**Only exact lookups are used, and that is the finding this script exists to
respect.** Measured against the committed column on 2026-09-03, RxNorm's
approximate matcher answers `beef tongue preparation` for
"Qi Zhi Tong Luo capsule", `miconazole` for "Jiedu Huayu Oral Prescription",
`benzoyl peroxide` for "BAC" and `phenazopyridine` for
"Amlodipine+standard antihypertensive therapy" -- all scoring 8-12, the same
band as its correct answers for Aspirin (10.4), Amlodipine (11.3) and
Atorvastatin (11.9). No threshold separates them, so approximate matching is
never used here.

The *ingredient* rollup is reported but never applied automatically either:
it answers `Isosorbide` for isosorbide mononitrate, dropping the ester,
`Choline` for choline alfoscerate, `Benzgalantamine` for galantamine, and
`Acetylcysteine` for NACA, which is a different compound. Those are exactly
the judgements a curator has to make, which is why this script prints and
stops.

    uv run python -m scripts.reconcile_drug_names
"""

import asyncio
import json
import logging
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Final

from dotenv import load_dotenv

from pipeline.database import Database
from pipeline.drug_names import normalize_drug_name

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

logger = logging.getLogger(__name__)

_RXNAV: Final[str] = "https://rxnav.nlm.nih.gov/REST"
_CHEMBL: Final[str] = "https://www.ebi.ac.uk/chembl/api/data"
_TIMEOUT: Final[int] = 30


def _get(url: str) -> Any:
    with urllib.request.urlopen(url, timeout=_TIMEOUT) as response:
        return json.load(response)


def rxnorm_match(term: str) -> dict[str, str] | None:
    """The RxNorm concept whose *normalised name* is `term`, or None.

    `search=1` is the normalised-string search, not the approximate one: it
    answers a concept or nothing, and never a neighbour.
    """
    query = urllib.parse.quote(term)
    ids = (_get(f"{_RXNAV}/rxcui.json?name={query}&search=1").get("idGroup") or {}).get(
        "rxnormId"
    )
    if not ids:
        return None
    rxcui = ids[0]
    groups = (
        _get(f"{_RXNAV}/rxcui/{rxcui}/related.json?tty=IN")
        .get("relatedGroup", {})
        .get("conceptGroup", [])
    )
    names = [c["name"] for g in groups for c in g.get("conceptProperties", [])]
    return {"source": "RxNorm", "id": rxcui, "name": names[0]} if names else None


def chembl_match(term: str) -> dict[str, str] | None:
    """ChEMBL's preferred name, when its search returns one that names `term`.

    The search is fuzzy at the tail, so a preferred name that does not carry
    the queried word is discarded rather than reported -- the rule
    `_matching_hit` already applies to Open Targets' drug search.
    """
    query = urllib.parse.quote(term)
    molecules = (
        _get(f"{_CHEMBL}/molecule/search?q={query}&format=json&limit=1").get("molecules")
        or []
    )
    if not molecules:
        return None
    preferred = molecules[0].get("pref_name")
    if not preferred or term.split()[0].casefold() not in preferred.casefold():
        return None
    return {
        "source": "ChEMBL",
        "id": molecules[0]["molecule_chembl_id"],
        "name": preferred,
    }


def resolve(name: str) -> dict[str, str] | None:
    for lookup in (rxnorm_match, chembl_match):
        try:
            hit = lookup(name)
        except Exception as error:  # noqa: BLE001 - a report, not a pipeline
            logger.debug("%s lookup failed for %r: %s", lookup.__name__, name, error)
            continue
        if hit:
            return hit
    return None


async def stored_drugs() -> list[str]:
    async with Database().connection() as conn:
        rows = await conn.fetch(
            "SELECT DISTINCT drug FROM clinical_trials "
            "WHERE drug IS NOT NULL ORDER BY drug"
        )
    return [row["drug"] for row in rows]


async def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    names = await stored_drugs()

    agreed: list[str] = []
    differs: list[tuple[str, dict[str, str]]] = []
    unknown: list[str] = []
    unclean: list[tuple[str, str]] = []

    for name in names:
        tidy = normalize_drug_name(name)
        if tidy and tidy != name:
            unclean.append((name, tidy))
        hit = resolve(name)
        if hit is None:
            unknown.append(name)
        elif hit["name"].casefold() == name.casefold():
            agreed.append(name)
        else:
            differs.append((name, hit))

    logger.info(
        "%d distinct drugs: %d confirmed, %d named differently, %d unknown to both",
        len(names),
        len(agreed),
        len(differs),
        len(unknown),
    )

    if unclean:
        logger.info("\nNot in normal form -- run scripts.normalize_drug_names:")
        for name, tidy in unclean:
            logger.info("  %-46r -> %r", name, tidy)

    logger.info("\nA registry names these differently. Each one is a judgement:")
    for name, hit in differs:
        logger.info("  %-46r %s %s: %s", name, hit["source"], hit["id"], hit["name"])

    logger.info(
        "\nNeither registry carries these -- research codes, herbal formulas "
        "and preparations. Nothing to reconcile:"
    )
    for name in unknown:
        logger.info("  %s", name)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
