"""Normalise the ``clinical_trials.drug`` string to the agent it names.

ClinicalTrials.gov states an intervention name however the sponsor wrote it,
so one agent arrives under many spellings -- ``Atorvastatin``,
``Atorvastatin 10 mg daily``, ``Atorvastatin 40 Mg Oral Tablet`` -- and some
strings are not a drug name at all but a whole arm: ``high dose group of
SaiLuoTong capsule``, ``Donepezil and self-generated memory training``. The
column is what a Table 2 row is *about*: `TrialsView` merges rows by it, and
the radar's sector spans are proportional to the unique drugs per population,
so five spellings of one statin widen a sector as though they were five drugs.

**This is deliberately a text rule and not a registry lookup.** Both RxNorm
and ChEMBL were measured against the committed strings, and an automatic
rename from either corrupts the column: RxNorm's ingredient rollup answers
``Isosorbide`` for isosorbide mononitrate (dropping the ester), ``Choline``
for choline alfoscerate, ``Benzgalantamine`` for galantamine and
``Acetylcysteine`` for NACA, which is a different compound; the fixed-dose
Triple Pill resolves to ``Amlodipine`` alone. Its approximate matcher is
worse -- ``Qi Zhi Tong Luo capsule`` scores ``beef tongue preparation`` and
``BAC`` scores ``benzoyl peroxide``, both inside the same score band as its
correct answers, so no threshold separates them. What the registries are good
for is *review*, and `scripts/reconcile_drug_names.py` is where they are read:
it reports an exact RxNorm or ChEMBL match with its identifier beside the
stored name and writes nothing, as `scripts/reconcile_omim.py` does for the
curated OMIM numbers.

So this module removes only what is demonstrably not the drug -- a dose, a
unit, a dose form, a route, an arm label, a trailing parenthetical acronym --
and leaves every judgement about what an agent *is* to a curator.
"""

import re
from collections import Counter, defaultdict
from collections.abc import Iterable
from typing import Final

# Dose ("40 Mg", "2.5mg", "5.8mg"), including the bare unit left behind when a
# sponsor writes the number and unit apart.
_DOSE: Final[re.Pattern[str]] = re.compile(
    r"\b\d+(?:\.\d+)?\s*(?:mg|mcg|µg|ug|g|ml|iu|%)\b", re.IGNORECASE
)

# Dose form, route and administration frequency. None of them name the agent.
_FORM: Final[re.Pattern[str]] = re.compile(
    r"\b(?:soft\s+)?(?:capsules?|tablets?|pills?|granules?|gel|ointment|"
    r"oral|sublingual|intravenous|iv|injections?|solutions?|suspensions?|"
    r"sustained-release|extended-release|dropping|prescription|"
    r"daily|once\s+daily|qd|bid|tid|xl|cr|sr|tabs?)\b",
    re.IGNORECASE,
)

# An arm label wrapping the agent: "high dose group of SaiLuoTong capsule".
_ARM_PREFIX: Final[re.Pattern[str]] = re.compile(
    r"^(?:very\s+)?(?:high|low|medium|standard|intensive)\s+dose\s+"
    r"(?:group\s+)?(?:of\s+)?",
    re.IGNORECASE,
)

# A co-intervention is a thing done *alongside* the drug -- behavioural
# therapy, background care, a bare "treatment" suffix. Its head noun is
# stripped and what remains is judged by `_is_agent`; a combination of two
# agents is kept whole (see `normalize_drug_name`).
_CO_INTERVENTION_HEAD: Final[re.Pattern[str]] = re.compile(
    r"\s*\b(?:therapy|therapies|treatment|training|rehabilitation|exercise|"
    r"counselling|counseling|education|care|management|regimen|"
    r"recommendations?|group|placebos?)\b\s*$",
    re.IGNORECASE,
)

# Abbreviations expanded only where the expansion is unambiguous, names a
# single agent, *and* already appears in the table under that spelling -- so
# the rewrite merges rather than invents. NBP qualifies on all three counts:
# NCT03906123's arm is dl-3-n-butylphthalide, it carries the same mechanism
# string as the five Butylphthalide rows, and two of those are in its own
# population -- so the radar drew one agent under two labels in one sector.
# DAPT is deliberately absent: "dual antiplatelet therapy" is a drug class
# rather than an agent, and expanding it would dress a class up as one.
_ABBREVIATIONS: Final[dict[str, str]] = {
    "ismn": "isosorbide mononitrate",
    "asa": "acetylsalicylic acid",
    "nbp": "butylphthalide",
}

# A row naming both a brand and its own generic keeps the generic. Nothing is
# invented -- the generic is already in the string -- which is what separates
# these from the brand-only names in the table (XYWAV, Mexidol, Prospekta,
# Cerebrolysin), where supplying one would be a curation act rather than a
# text rule. It cannot be a pattern either: "(Udenafil)" is the generic and
# "(Aricept)" the brand, both parenthesised and both lower-case, so which
# half to keep is knowledge and belongs in a list.
_BRAND_FOLDS: Final[dict[str, str]] = {
    "zydena (udenafil)": "Udenafil",  # Dong-A's brand for udenafil
    "akatinol memantine": "Memantine",  # Merz's brand for memantine
    "donepezil hydrochloride (aricept)": "Donepezil",  # Eisai's, plus the salt
}

# Salt forms folded to the ingredient, each one confirmed by an exact RxNorm
# lookup and accepted by a curator. The registry drops nothing here but a
# counter-ion, which is why these six and not the other twenty-nine the
# reconciliation report offers: `Isosorbide mononitrate -> isosorbide` loses
# the ester, `Choline alfoscerate -> choline` loses the alfoscerate,
# `Galantamine -> benzgalantamine` names a different prodrug and
# `NACA -> acetylcysteine` a different compound.
#
# "Donepezil hydrochloride (Aricept)" is not here but in `_BRAND_FOLDS`: the
# salt fold alone would leave "Donepezil (Aricept)", which is neither
# spelling, so dropping the brand has to happen in the same step.
_SALT_FOLDS: Final[dict[str, str]] = {
    "donepezil hydrochloride": "Donepezil",  # RxNorm 135447
    "donepezil hcl": "Donepezil",  # RxNorm 135447
    "lidocaine hydrochloride": "Lidocaine",  # RxNorm 142440
    "atorvastatin calcium": "Atorvastatin",  # RxNorm 83366
    "galantamine hydrobromide": "Galantamine",  # RxNorm 860693
    "n acetylcysteine": "Acetylcysteine",  # RxNorm 197
}

# Adjectives that describe an arm rather than name an agent. A remainder made
# only of these is a comparator label ("Regular treatment", "the control
# group"), whatever its capitalisation.
_GENERIC_ARM_WORDS: Final[frozenset[str]] = frozenset(
    {
        "the", "a", "an", "regular", "usual", "standard", "conventional",
        "background", "routine", "active", "control", "comparator", "best",
        "supportive", "basic", "intensive", "normal", "sham",
    }
)

_SPLIT: Final[re.Pattern[str]] = re.compile(r"\s*(?:\+|/|\band\b|\bplus\b)\s*",
                                            re.IGNORECASE)
_TRAILING: Final[re.Pattern[str]] = re.compile(r"^[\s,;:+/-]+|[\s,;:+/-]+$")


def _drop_acronym(part: str) -> str:
    """Drop a trailing parenthetical acronym. The label is the agent's name.

    A radar label is read beside its marker at figure scale, so a trailing
    code earns none of the width it costs: "Butylphthalide (NBP)",
    "Mivelsiran (ALN-APP)" and "Palm tocotrienols complex (HOV-12020)" say
    nothing the name before them does not, and the trial's own identity is
    already carried by `registryId`.

    An acronym is a parenthetical carrying no lower-case letter -- capitals,
    digits and hyphens only. That is what separates `(NBP)`, `(ISMN)`,
    `(CBS)`, `(ASA)`, `(ALN-APP)` and `(HOV-12020)`, all dropped, from
    `(Aricept)`, `(Udenafil)` and `(delta-THC)`, which are a brand, a generic
    name and a chemical abbreviation written as a word, and are kept.

    This rewrites three curated spellings, which is a curator's decision and
    was made as one: the development codes are lost from the label and live
    on only in the registry record.
    """
    match = re.search(r"\s*\(([A-Z0-9][A-Z0-9-]{0,11})\)\s*$", part)
    if match is None or not match.group(1).strip("-"):
        return part
    stem = part[: match.start()].strip()
    # "(ALN-APP)" alone is the whole name for nothing; keep it rather than
    # resolve a string to empty.
    return stem or part


def _clean_part(part: str) -> str:
    """Strip dose, unit, form, arm label and a trailing parenthetical acronym."""
    out = _drop_acronym(part)
    out = _ARM_PREFIX.sub("", out)
    out = _DOSE.sub(" ", out)
    out = _FORM.sub(" ", out)
    out = re.sub(r"\s{2,}", " ", out)
    out = _TRAILING.sub("", out)
    return _ABBREVIATIONS.get(out.lower(), out)


def _agent_of(part: str) -> str | None:
    """The agent `part` names once its co-intervention head noun is removed.

    "BAC treatment" leaves "BAC", a named agent, and is kept as that.
    "Regular treatment" leaves "Regular", "intensive antihypertensive therapy"
    leaves "intensive antihypertensive" and "self-generated memory training"
    leaves "self-generated memory", none of which names one.

    Two rules reject those and keep "BAC": a remainder made only of arm
    adjectives is one, and so is a multi-word remainder of ordinary
    lower-case words. A drug name is a proper noun or a code, so it carries a
    capital past its first letter, a digit, or nothing but one word.
    """
    if part.lower() in _ABBREVIATIONS.values():
        return part
    if not _CO_INTERVENTION_HEAD.search(part):
        return part
    remainder = _TRAILING.sub("", _CO_INTERVENTION_HEAD.sub("", part))
    if not remainder:
        return None
    words = remainder.split()
    if all(word.lower() in _GENERIC_ARM_WORDS for word in words):
        return None
    if len(words) > 1 and not re.search(r"[A-Z0-9]", remainder):
        return None
    return remainder


def _join(parts: list[str]) -> str:
    """"a", "b", "c" -> "a, b and c" -- the combination reads as one agent."""
    if len(parts) == 1:
        return parts[0]
    return ", ".join(parts[:-1]) + " and " + parts[-1]


def normalize_drug_name(raw: str | None) -> str | None:
    """The agent `raw` names, or None when it names none.

    Dose, unit, dose form, route and arm label are removed. A co-intervention
    beside the drug is dropped and the drug kept; a combination of two or
    more agents is kept whole, because a fixed-dose Triple Pill is not
    amlodipine and must not merge with it.

    Capitalisation reaches the first letter only, and only when the first
    word carries no capital of its own: "aspirin" becomes "Aspirin", while
    "rt-PA" and "mRNA" keep the capital that identifies them. A full title
    case would rewrite "SaiLuoTong" and "N-acetylcysteine" as well.
    """
    if raw is None:
        return None
    text = _TRAILING.sub("", raw)
    if not text:
        return None

    parts = (_clean_part(part) for part in _SPLIT.split(text))
    agents = [agent for agent in (_agent_of(part) for part in parts if part) if agent]

    # Every part read as a co-intervention: the string named an arm, not an
    # agent. "Regular treatment", "the control group", "Placebos".
    if not agents:
        return None

    # A combination lower-cases each agent after the first, so
    # "Telmisartan, amlodipine and indapamide" reads as one intervention.
    head, *tail = agents
    joined = _join([head] + [_lower_first(part) for part in tail])
    key = joined.casefold()
    return _BRAND_FOLDS.get(key) or _SALT_FOLDS.get(key) or _upper_first(joined)


def fold_case_variants(names: Iterable[str]) -> dict[str, str]:
    """Map each name onto the spelling the table uses most for it.

    `normalize_drug_name` is per name and cannot see that two sponsors wrote
    the same agent as "Isosorbide Mononitrate" and "Isosorbide mononitrate":
    both are already capitalised, and lower-casing the interior would rewrite
    "Tian Ma Bian Chun Zhi Gan" and "SaiLuoTong" as well. The fold is decided
    by the data instead -- the most frequent spelling wins, ties broken by
    sort order so the result does not depend on iteration order.
    """
    counts: dict[str, Counter[str]] = defaultdict(Counter)
    for name in names:
        counts[name.casefold()][name] += 1
    winners: dict[str, str] = {}
    for group in counts.values():
        best = max(sorted(group), key=lambda spelling: group[spelling])
        for spelling in group:
            winners[spelling] = best
    return winners


def _upper_first(name: str) -> str:
    first = name.split(" ", 1)[0]
    return name if any(ch.isupper() for ch in first) else name[:1].upper() + name[1:]


def _lower_first(name: str) -> str:
    first = name.split(" ", 1)[0]
    if any(ch.isupper() for ch in first[1:]):
        return name
    return name[:1].lower() + name[1:]
