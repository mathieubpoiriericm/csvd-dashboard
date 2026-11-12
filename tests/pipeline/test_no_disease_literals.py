"""No disease term survives in pipeline/ or scripts/ outside disease/.

Nor in the tests that hold for any disease: a test that names the disease
lives in a `csvd/` tree, which a fork deletes, so the generic trees are held
to the rule the code is -- here, where those trees are. A fork has deleted
them and has nowhere to move a test to, and the generic tests it inherits
name their own example disease, which is the one the adapt wizard's check
builds its fork for: there the scan of the tests is skipped.

The trait vocabulary (disease/vocabulary.json) and the manifest's trial
populations are scanned for as well, in the code and in the generic tests,
and only where the `csvd/` trees are, for a second reason: a fork's traits
and populations are whatever its curators typed into the wizard, and one of
them may be an ordinary word the code uses for something else.
"""

import json
import re
from collections.abc import Callable, Iterable
from pathlib import Path

import pytest

from pipeline.disease import MANIFEST_PATH, VOCABULARY_PATH, load_disease

_ROOT = Path(__file__).resolve().parents[2]
_ROOTS = ("pipeline", "scripts")
# The Python tests: tests/pipeline, tests/scripts and the helpers beside
# them. Their `csvd/` subtrees are where the disease is named, and this file
# names its terms in the allow-list below.
_TEST_ROOTS = ("tests",)
_DISEASE_TREE = "csvd"
_DISEASE_TREES = ("tests/pipeline/csvd", "tests/scripts/csvd")

# (relative path, term) -> reason. Whole-word matching means SVDPMIDTOKEN
# and _svd_started_monotonic never match and need no entry, and the
# abbreviation, the short form and the gene symbols match as written, so the
# lower-case svd and csvd of a path or a CSS property never match either. An
# entry is for text that names a term for another reason; a fork adds its own
# the same way.
_RETIRED_SYMBOL = (
    "worked example of a symbol NCBI retired (C6orf195 now answers as "
    "LINC01600), quoted from the measured record"
)
_MEASURED_TRAIT = (
    "comment recording what a run or the committed cassettes measured or "
    "stored under this trait's name"
)
_GOLD_POPULATION = (
    "a target-population group the curators gave gold trials, a data value "
    "keyed by registry ID in POPULATION_GROUP"
)
_FORK_EDIT_POINT = (
    "a key of _ADMITTED_UNASKED, the traits the schema admits and the prompt "
    "never asks for: the one declaration of this file a fork edits, and the "
    "adapt wizard's check empties it by name, so it cannot move to a csvd/ "
    "tree. The entry excuses the term anywhere in that file, which is more "
    "than the declaration: a test there that names one of these is not caught"
)
_PROMPT_VOCABULARY = "tests/pipeline/test_prompt_vocabulary.py"

_ALLOWED: dict[tuple[str, str], str] = {
    (
        "pipeline/pdf_retrieval.py",
        "csvd-dashboard",
    ): "the tool name NCBI knows the pipeline by",
    (
        "pipeline/clinvar_fetch.py",
        "HTRA1",
    ): "comment quoting a measured ClinVar record count",
    (
        "pipeline/clinvar_fetch.py",
        "NOTCH3",
    ): "comment quoting a measured ClinVar record count",
    (
        "pipeline/clinvar_fetch.py",
        "TREX1",
    ): "comment quoting a measured ClinVar record count",
    (
        "pipeline/citations.py",
        "NOTCH3",
    ): "worked example for the single-sentence rule",
    (
        "pipeline/config.py",
        "NOTCH3",
    ): "comment quoting a measured ClinVar record count",
    (
        "pipeline/config.py",
        "HTRA1",
    ): "comment quoting a measured Open Targets association count",
    (
        "pipeline/orphadata_fetch.py",
        "HTRA1",
    ): "comment recording a verified endpoint probe and real OMIM numbers",
    (
        "pipeline/export/omim.py",
        "AD",
    ): "OMIM's inheritance code (autosomal dominant), not a disease",
    (
        "pipeline/annotations.py",
        "C6orf195",
    ): _RETIRED_SYMBOL,
    (
        "pipeline/annotations.py",
        "LINC01600",
    ): _RETIRED_SYMBOL,
    (
        "pipeline/clinvar_fetch.py",
        "C6orf195",
    ): _RETIRED_SYMBOL,
    (
        "pipeline/clinvar_fetch.py",
        "LINC01600",
    ): _RETIRED_SYMBOL,
    (
        "pipeline/data_merger.py",
        "C6orf195",
    ): _RETIRED_SYMBOL,
    (
        "pipeline/data_merger.py",
        "LINC01600",
    ): _RETIRED_SYMBOL,
    (
        "pipeline/ncbi_http.py",
        "C6orf195",
    ): _RETIRED_SYMBOL,
    (
        "pipeline/ncbi_http.py",
        "LINC01600",
    ): _RETIRED_SYMBOL,
    (
        "pipeline/uniprot_fetch.py",
        "C6orf195",
    ): _RETIRED_SYMBOL,
    (
        "pipeline/uniprot_fetch.py",
        "LINC01600",
    ): _RETIRED_SYMBOL,
    (
        "scripts/load_gold.py",
        "SVD",
    ): _GOLD_POPULATION,
    (
        "scripts/load_gold.py",
        "Stroke",
    ): _GOLD_POPULATION,
    (
        "scripts/load_gold.py",
        "CAA",
    ): _GOLD_POPULATION,
    (
        "scripts/load_gold.py",
        "Cognitive Impairment",
    ): _GOLD_POPULATION,
    (
        "pipeline/extraction_models.py",
        "PVWMH",
    ): _MEASURED_TRAIT,
    (
        "pipeline/extraction_models.py",
        "ICH-non-lobar",
    ): _MEASURED_TRAIT,
    (
        "pipeline/export/tables.py",
        "ICH-non-lobar",
    ): _MEASURED_TRAIT,
    (_PROMPT_VOCABULARY, "CMB"): _FORK_EDIT_POINT,
    (_PROMPT_VOCABULARY, "NODDI"): _FORK_EDIT_POINT,
    (_PROMPT_VOCABULARY, "lacunar stroke"): _FORK_EDIT_POINT,
    (_PROMPT_VOCABULARY, "MTAG (all ICH, SVS, WMH, FA, MD, AD)"): _FORK_EDIT_POINT,
    (_PROMPT_VOCABULARY, "ICH"): _FORK_EDIT_POINT,
    (_PROMPT_VOCABULARY, "non-lobar ICH"): _FORK_EDIT_POINT,
    (_PROMPT_VOCABULARY, "All ICH & lobar ICH only"): _FORK_EDIT_POINT,
    (_PROMPT_VOCABULARY, "lacunes (suggestive significance)"): _FORK_EDIT_POINT,
}


def _whole_words(terms: Iterable[str], flags: int = 0) -> re.Pattern[str] | None:
    # Longest first: alternation takes the first alternative that matches at
    # a position, and a trait key can begin with another ("WMH" and
    # "WMH-cortical-atrophy").
    alternatives = sorted(
        {re.escape(term.strip()) for term in terms if term.strip()},
        key=lambda term: (-len(term), term),
    )
    if not alternatives:
        return None
    # Lookarounds rather than \b, which needs a word character on the term's
    # side of the boundary: a term may end in a bracket.
    return re.compile(r"(?<!\w)(?:" + "|".join(alternatives) + r")(?!\w)", flags)


def _term_finder(
    caseless: Iterable[str], exact: Iterable[str]
) -> Callable[[str], list[str]]:
    """The terms a line names, as written in it.

    A name is prose and matches in any case. An abbreviation, a short form or
    a gene symbol is an identifier whose case is its meaning -- "PD" is not
    ``import pandas as pd``, "APP" not "the app", "MS" not a millisecond
    parameter -- so it matches as written.
    """
    names = _whole_words(caseless, re.IGNORECASE)
    identifiers = _whole_words(exact)

    def find(line: str) -> list[str]:
        named = list(names.finditer(line)) if names is not None else []
        found = [match.group(0) for match in named]
        if identifiers is None:
            return found
        # An identifier inside a name already found is part of that name: a
        # trait's spelled-out name can hold another trait's key.
        spans = [match.span() for match in named]
        found.extend(
            match.group(0)
            for match in identifiers.finditer(line)
            if not any(a <= match.start() and match.end() <= b for a, b in spans)
        )
        return found

    return find


def test_the_term_finder_matches_names_in_any_case_and_identifiers_as_written() -> (
    None
):
    find = _term_finder(["Paris Brain Institute"], ["PD", "APP", "MS"])
    assert find("import pandas as pd") == []
    assert find("the Shiny app, and App itself") == []
    assert find("def wait(ms: int) -> None:") == []
    assert find("APP processing in MS") == ["APP", "MS"]
    assert find("the paris brain institute") == ["paris brain institute"]
    # Python's word boundaries already know every script.
    assert _term_finder(["Charité"], ["β-thalassemia"])(
        "Charité's β-thalassemia cohort"
    ) == ["Charité", "β-thalassemia"]
    assert _term_finder([], ["cSVD", "SVD"])("SVDPMIDTOKEN _svd_x cSVDs") == []
    assert _term_finder([], [])("anything") == []


def _manifest_terms() -> tuple[list[str], list[str]]:
    """The manifest's own terms: those matched in any case, those as written."""
    d = load_disease()
    return (
        ["csvd-dashboard", d.name],
        [
            d.abbreviation,
            d.short,
            *d.monogenic_genes,
            *d.gene_aliases,
            *(member for members in d.gene_aliases.values() for member in members),
        ],
    )


def _is_ordinary_word(term: str) -> bool:
    """One all-lower-case word: something the code may say for another reason.

    The vocabulary holds a trait keyed `stroke`, and SVG has an attribute of
    that name on a hundred lines of the renderers. A key with a capital, a
    digit, a hyphen or a space is an identifier, and that is what is scanned
    for.
    """
    return term.isalpha() and term.islower()


def _vocabulary_terms() -> tuple[list[str], list[str]]:
    """The trait vocabulary's terms: names in any case, identifiers as written.

    A trait's key and label, a synonym's two spellings and an untracked term
    are identifiers; a trait's spelled-out name is prose, and only a name of
    several words is distinctive enough to scan for in any case.
    """
    vocabulary = json.loads(VOCABULARY_PATH.read_text(encoding="utf-8"))
    traits = vocabulary.get("traits", [])
    synonyms = vocabulary.get("synonyms", [])
    exact = {
        *(trait[field] for trait in traits for field in ("key", "label")),
        *(synonym[field] for synonym in synonyms for field in ("from", "to")),
        *(entry["term"] for entry in vocabulary.get("untracked", [])),
    }
    names = {trait["name"] for trait in traits if " " in trait["name"].strip()}
    # A name that is also a key or a label stays a name: matched in any case,
    # which covers the spelling the key has.
    return (
        sorted(names),
        sorted(term for term in exact - names if not _is_ordinary_word(term)),
    )


def _population_terms() -> tuple[list[str], list[str]]:
    """The manifest's trial populations, as written, but for an ordinary word."""
    populations = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))["populations"]
    exact = {entry[field] for entry in populations for field in ("key", "label")}
    return [], sorted(term for term in exact if not _is_ordinary_word(term))


def test_an_ordinary_word_is_not_a_vocabulary_term_to_scan_for() -> None:
    assert _is_ordinary_word("stroke")
    for identifier in ("Stroke", "WMH", "lacunar stroke", "ICH-lobar", "t1"):
        assert not _is_ordinary_word(identifier), identifier


def test_the_vocabulary_s_terms_are_built_as_the_scan_needs_them(
    tmp_path, monkeypatch
) -> None:
    vocabulary = tmp_path / "vocabulary.json"
    vocabulary.write_text(
        json.dumps(
            {
                "traits": [
                    {"key": "AB", "label": "AB", "name": "Alpha beta burden"},
                    {"key": "pain", "label": "Pain", "name": "Pain"},
                    {"key": "Late onset", "label": "Late onset", "name": "Late onset"},
                    {"key": "MIX (all AB, CD)", "label": "m", "name": "m"},
                ],
                "synonyms": [{"from": "alpha-beta", "to": "AB"}],
                "untracked": [{"term": "AB-cortical"}],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(f"{__name__}.VOCABULARY_PATH", vocabulary)

    caseless, exact = _vocabulary_terms()
    # A name of several words is prose, and stays so when a key spells it too.
    assert caseless == ["Alpha beta burden", "Late onset"]
    # `pain` and `m` are ordinary words; `Pain`, with its capital, is a label.
    assert exact == ["AB", "AB-cortical", "MIX (all AB, CD)", "Pain", "alpha-beta"]

    find = _term_finder(caseless, exact)
    assert find("the LATE ONSET cohort") == ["LATE ONSET"]
    # Longest first, so a key that begins with another is matched whole.
    assert find('"AB-cortical"') == ["AB-cortical"]
    # A term may end in a bracket, where \\b would find no boundary.
    assert find('"MIX (all AB, CD)",') == ["MIX (all AB, CD)"]
    assert find("pain in the m dimension") == []
    # A key inside a name that was found is not a second hit.
    assert find("alpha beta burden, and AB") == ["alpha beta burden", "AB"]
    named = _term_finder(["Burden of AB"], ["AB"])
    assert named("the burden of AB") == ["burden of AB"]


def _hits(
    roots: Iterable[str],
    skip: Callable[[Path], bool],
    *terms: tuple[list[str], list[str]],
) -> list[str]:
    """Every line under *roots* that names one of *terms* and may not."""
    # "csvd-dashboard" is tried before the shorter term it begins with, since
    # the alternation is ordered longest first: otherwise it would only ever
    # match as that term, never as the tool name the allow-list above names.
    find = _term_finder(
        [term for caseless, _ in terms for term in caseless],
        [term for _, exact in terms for term in exact],
    )
    hits: list[str] = []
    for root in roots:
        for path in sorted((_ROOT / root).rglob("*")):
            if path.suffix not in {".py", ".j2"} or "alembic/versions" in str(path):
                continue
            if skip(path):
                continue
            rel = path.relative_to(_ROOT).as_posix()
            for number, line in enumerate(
                path.read_text(encoding="utf-8").splitlines(), 1
            ):
                for term in find(line):
                    if (rel, term) in _ALLOWED:
                        continue
                    hits.append(f"{rel}:{number}: {line.strip()}")
    return hits


def test_no_disease_literal_remains_outside_disease() -> None:
    assert _hits(_ROOTS, lambda path: False, _manifest_terms()) == [], (
        "Reword each line so it names no term of the disease, or, when the "
        "text means something else (a quoted measurement, a tool name), add "
        "an entry to _ALLOWED in tests/pipeline/test_no_disease_literals.py: "
        "the file, the term as written and the reason."
    )


def _has_disease_trees() -> bool:
    return any((_ROOT / tree).is_dir() for tree in _DISEASE_TREES)


def _skip_without_the_disease_trees() -> None:
    if not _has_disease_trees():
        pytest.skip(
            f"neither {' nor '.join(_DISEASE_TREES)} exists: the "
            "scan keeps the disease's tests inside those trees, and this "
            "checkout has none"
        )


def test_no_vocabulary_term_remains_outside_disease() -> None:
    _skip_without_the_disease_trees()
    hits = _hits(_ROOTS, lambda path: False, _vocabulary_terms(), _population_terms())
    assert hits == [], (
        "Reword each line so it names no trait of disease/vocabulary.json "
        "and no trial population of the manifest, or read it from there. "
        "When the text quotes a measurement that the name is part of, add "
        "an entry to _ALLOWED in tests/pipeline/test_no_disease_literals.py: "
        "the file, the term as written and the reason."
    )


def test_no_disease_literal_remains_in_the_generic_tests() -> None:
    _skip_without_the_disease_trees()

    def skip(path: Path) -> bool:
        return (
            _DISEASE_TREE in path.relative_to(_ROOT).parts
            or path == Path(__file__).resolve()
        )

    hits = _hits(
        _TEST_ROOTS,
        skip,
        _manifest_terms(),
        _vocabulary_terms(),
        _population_terms(),
    )
    assert hits == [], (
        f"A test that names the disease belongs in a {_DISEASE_TREE}/ tree. "
        "Move it there, or make it hold for any disease: a placeholder for "
        "an arbitrary gene or trait, a value read from the manifest, the "
        "vocabulary or the committed data at test time, a comment reworded. "
        "When the text means something else, add an entry to _ALLOWED in "
        "tests/pipeline/test_no_disease_literals.py: the file, the term as "
        "written and the reason."
    )


def test_every_allow_list_entry_is_still_needed() -> None:
    for (rel, term), _reason in _ALLOWED.items():
        if rel.startswith(_TEST_ROOTS) and not _has_disease_trees():
            # The tests are not scanned here, so an entry for one excuses
            # nothing, and a fork has edited what it names.
            continue
        text = (_ROOT / rel).read_text(encoding="utf-8")
        # The scan's own boundaries: a term may end in a bracket.
        assert re.search(
            rf"(?<!\w){re.escape(term)}(?!\w)", text
        ), f"{rel} no longer names {term}"
