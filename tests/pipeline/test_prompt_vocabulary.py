"""The prompt's trait vocabulary is reconciled against disease/vocabulary.json.

The canonical GWAS trait abbreviations are named in prose, and that sentence is
prose in `disease/prompt.md`, rendered into the v7 template; the cSVD rendering
is pinned byte-for-byte by `test_prompt_assembly.py`, so an edit is a visible
fixture change rather than a silent one. Deriving the sentence from
`disease/vocabulary.json` instead would let an edit there change what the model
is asked with nothing to show it. The reconciliation happens here instead.

Two artifacts fix what a run may report, and only one of them is frozen. The
sentence is what the model is *asked* for; the tool schema's `gwas_trait` enum
-- `CANONICAL_TRAITS`, generated from `disease/vocabulary.json` at import time and
sent on every request -- is what it is *allowed* to say, and it is the half the
API enforces. So the enum is part of the method too: a `traits[*].key` added or
renamed changes what a run may report with no prompt edit and no re-recorded
cassette. The reconciliation below therefore runs in both directions.

The bug this exists for: the prompt asked for 23 abbreviations while the
dashboard carried 14, and `PVWMH` -- the second most extracted trait across
`logs/json/pipeline_report_*.json` -- had no filter choice, no phenogram entry
and no synonym fold. It would have failed `tests/phenogram_encoding_test.ts` the
moment it reached `data/table1.json`. Every term the model is told to emit now
carries a recorded disposition: a tracked trait, a synonym fold, or an
`untracked` entry with a reason.
"""

import json
import re
from pathlib import Path
from typing import Final

import pytest

from pipeline.config import PROJECT_ROOT
from pipeline.extraction_models import CANONICAL_TRAITS
from pipeline.prompts import _PROMPTS, PROMPT_VERSIONS_WITHOUT_PROVENANCE

_VOCABULARY: Final[Path] = PROJECT_ROOT / "disease" / "vocabulary.json"

# The one sentence in the instructions that fixes the output vocabulary.
_CANONICAL: Final[re.Pattern[str]] = re.compile(
    r"gwas_trait: Use ONLY these canonical abbreviations: (?P<terms>.*?)\."
    r" Do not use full phenotype names\.",
    re.S,
)

# Versions config will actually accept; the rest are refused at startup. Read
# from the registry rather than listed, so deleting a version or adding v7
# needs no edit here.
_USABLE: Final[tuple[str, ...]] = tuple(
    sorted(set(_PROMPTS) - PROMPT_VERSIONS_WITHOUT_PROVENANCE)
)


# Terms the schema admits that the canonical sentence never names, each with
# the reason it is admitted unasked. This is the allow-list for the reverse
# direction: everything else in the enum has to be a term the prompt asks for.
# Adding an entry is a change to what the model may report, so it carries a
# reason here rather than passing silently as a vocabulary edit.
_ADMITTED_UNASKED: Final[dict[str, str]] = {
    "CMB": (
        "The tracked key behind the prompt's `cerebral-microbleeds`. The fold "
        "target has to be sayable too -- TRAIT_SYNONYMS maps one onto the "
        "other, and a model that writes the curated code rather than the "
        "prompt's spelling must not fail validation for it."
    ),
    "NODDI": (
        "A curated trait the dashboard carries (filter choice, phenogram "
        "pill, one row in data/table1.json). The sentence asks for its three "
        "derived measures -- ICVF, ISOVF, OD -- and not for the model name, "
        "so a paper reporting NODDI itself would otherwise have no term."
    ),
    "lacunar stroke": (
        "A curated trait the dashboard carries, distinct from `lacunes` (the "
        "imaging marker) and from `SVS`. The model uses it: the recorded "
        "cassette for PMID 33773637 emits it 14 times where the sentence "
        "asks for `lacunes`, and both spellings are separate values in "
        "data/table1.json. Reconciling them is a curation decision, not a "
        "test change."
    ),
}


def _vocabulary() -> dict:
    with _VOCABULARY.open(encoding="utf-8") as handle:
        return json.load(handle)


def _prompt_terms(version: str) -> frozenset[str]:
    """The canonical abbreviations named by one prompt version."""
    _, instructions = _PROMPTS[version]
    match = _CANONICAL.search(instructions)
    assert match is not None, (
        f"{version}: no canonical-abbreviation sentence. If the wording moved, "
        "update _CANONICAL -- do not delete this test."
    )
    return frozenset(
        term.strip()
        for term in match.group("terms").replace("\n", " ").split(",")
        if term.strip()
    )


def _declared() -> dict[str, frozenset[str]]:
    vocabulary = _vocabulary()
    return {
        "tracked": frozenset(t["key"] for t in vocabulary["traits"]),
        "synonym": frozenset(s["from"] for s in vocabulary["synonyms"]),
        # Only prompt-sourced synonyms are the prompt's to account for; a
        # curated spelling comes from the source spreadsheet and never appears
        # in the canonical list.
        "synonym_from_prompt": frozenset(
            s["from"] for s in vocabulary["synonyms"] if s["source"] == "prompt"
        ),
        "untracked": frozenset(u["term"] for u in vocabulary["untracked"]),
    }


def test_there_is_a_usable_prompt_version() -> None:
    """Guards the parametrised tests below against silently covering nothing."""
    assert _USABLE, "every prompt version is refused at config time"


@pytest.mark.parametrize("version", _USABLE)
def test_every_prompt_term_has_a_recorded_disposition(version: str) -> None:
    """No term may be asked for without the vocabulary accounting for it."""
    declared = _declared()
    known = declared["tracked"] | declared["synonym"] | declared["untracked"]
    orphans = sorted(_prompt_terms(version) - known)
    assert not orphans, (
        f"{version} asks the model for {orphans}, which disease/vocabulary.json does "
        "not declare. Such a term reaches data/table1.json with no filter choice "
        "and no phenogram entry. Add it to `traits`, fold it in `synonyms`, or "
        "record it in `untracked` with a reason."
    )


@pytest.mark.parametrize("version", _USABLE)
def test_every_prompt_term_is_admitted_by_the_schema(version: str) -> None:
    """What the prompt asks for, the tool's enum must accept.

    The vocabulary accounted for `cerebral-microbleeds` as a synonym while
    the enum was built from traits and untracked terms only, so the prompt
    told the model to say a word the schema then refused: one
    ValidationError, one retry, and the paper lost. Reconciling prompt
    against vocabulary was not enough; this reconciles prompt against
    schema.
    """
    refused = sorted(_prompt_terms(version) - set(CANONICAL_TRAITS))
    assert not refused, (
        f"{version} asks the model for {refused}, which the extraction schema's "
        "enum does not admit. A model that obeys the prompt fails validation."
    )


@pytest.mark.parametrize("version", _USABLE)
def test_the_schema_admits_nothing_the_prompt_does_not_ask_for(version: str) -> None:
    """The other direction, and the one that was missing.

    The enum is generated from disease/vocabulary.json at import time and is
    what the API enforces, so a trait key added or renamed there changes
    what the model may emit with no prompt edit, no cassette re-record and
    -- until this test -- no failure. `lacunar stroke` reached
    data/table1.json that way, beside the `lacunes` the prompt asks for.

    A term the schema should admit unasked belongs in _ADMITTED_UNASKED
    with its reason. Widening the test instead is how the drift the frozen
    sentence exists to prevent gets in through the schema.
    """
    unasked = sorted(
        set(CANONICAL_TRAITS) - _prompt_terms(version) - set(_ADMITTED_UNASKED)
    )
    assert not unasked, (
        f"the extraction schema admits {unasked}, which {version} never asks "
        "the model for. The enum is part of the method: a term in it is a term "
        "a run may publish. Ask for it in the prompt (a frozen-sentence edit, "
        "with the cassettes re-recorded), or record it in _ADMITTED_UNASKED "
        "with the reason it is admitted unasked."
    )


@pytest.mark.parametrize("version", _USABLE)
def test_the_admitted_unasked_list_does_not_go_stale(version: str) -> None:
    """Each entry exists because the prompt does not ask for it and the
    schema does admit it; neither may quietly stop being true."""
    named = sorted(set(_ADMITTED_UNASKED) & _prompt_terms(version))
    assert not named, (
        f"{version} now asks the model for {named}, so the _ADMITTED_UNASKED "
        "entry is spent -- delete it."
    )
    refused = sorted(set(_ADMITTED_UNASKED) - set(CANONICAL_TRAITS))
    assert not refused, (
        f"{refused} is allow-listed but the schema no longer admits it; the "
        "entry describes a term that cannot be emitted at all."
    )
    for term, reason in _ADMITTED_UNASKED.items():
        assert reason.strip(), f"{term}: no reason given"


@pytest.mark.parametrize("version", _USABLE)
def test_synonyms_and_untracked_terms_earn_their_place(version: str) -> None:
    """Prompt-sourced entries exist only to account for it; none may go stale.

    A `source: "curated"` synonym is exempt: it folds a spelling from the source
    spreadsheet, which the prompt has never asked for.
    """
    declared = _declared()
    prompt = _prompt_terms(version)
    stale = sorted((declared["synonym_from_prompt"] | declared["untracked"]) - prompt)
    assert not stale, (
        f"disease/vocabulary.json accounts for {stale}, which {version} no longer "
        "asks for. Delete the entry, or promote it to a tracked trait if the "
        "dashboard should carry it."
    )


def test_the_vocabulary_does_not_contradict_itself() -> None:
    declared = _declared()
    vocabulary = _vocabulary()

    for left, right in (
        ("tracked", "synonym"),
        ("tracked", "untracked"),
        ("synonym", "untracked"),
    ):
        overlap = sorted(declared[left] & declared[right])
        assert not overlap, f"{overlap} is both {left} and {right}"

    targets = {s["to"] for s in vocabulary["synonyms"]}
    unknown = sorted(targets - declared["tracked"])
    assert not unknown, f"synonyms fold onto unknown traits: {unknown}"

    keys = [t["key"] for t in vocabulary["traits"]]
    assert len(keys) == len(set(keys)), "trait keys repeat"


def test_every_synonym_declares_where_it_came_from() -> None:
    """`prompt` is reconciled against the canonical list; `curated` is exempt."""
    for entry in _vocabulary()["synonyms"]:
        assert entry.get("source") in {"prompt", "curated"}, (
            f"{entry['from']}: source must be 'prompt' or 'curated'"
        )
        assert entry.get("note", "").strip(), f"{entry['from']}: no note given"


def test_untracked_terms_carry_a_reason() -> None:
    """An untracked term is a decision, and a decision without a reason is a gap."""
    for entry in _vocabulary()["untracked"]:
        assert entry.get("reason", "").strip(), f"{entry['term']}: no reason given"
