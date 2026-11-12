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

import ast
import io
import json
import re
import tokenize
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from functools import cache
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

# (relative path, term) -> where the file may name the term, and why.
# Whole-word matching means SVDPMIDTOKEN and _svd_started_monotonic never
# match and need no entry, and the abbreviation, the short form and the gene
# symbols match as written, so the lower-case svd and csvd of a path or a CSS
# property never match either. An entry is for text that names a term for
# another reason; a fork adds its own the same way.
#
# An entry excuses less than its file, and less than a line. `_prose` is for
# a comment or a docstring that quotes a measurement: the same term in code,
# on that line or another, or in a string a statement uses, is still a hit.
# `_declared` is for a value the code needs: the term is excused inside the
# module-level assignment it names and nowhere else. Both read the file as
# Python, so an entry is for a .py file.
@dataclass(frozen=True)
class _Excuse:
    reason: str
    # The module-level name whose assignment may hold the term; None for
    # comments and docstrings.
    declaration: str | None = None

    @property
    def where(self) -> str:
        if self.declaration is None:
            return "in a comment or a docstring"
        return f"inside the module-level assignment to {self.declaration}"


def _prose(reason: str) -> _Excuse:
    return _Excuse(reason)


def _declared(name: str, reason: str) -> _Excuse:
    return _Excuse(reason, declaration=name)


_RETIRED_SYMBOL = _prose(
    "worked example of a symbol NCBI retired (C6orf195 now answers as "
    "LINC01600), quoted from the measured record"
)
_MEASURED_COUNT = "comment quoting a measured ClinVar record count"
_MEASURED_TRAIT = _prose(
    "comment recording what a run or the committed cassettes measured or "
    "stored under this trait's name"
)
_FORK_EDIT_POINT = _declared(
    "_ADMITTED_UNASKED",
    "a key of the traits the schema admits and the prompt never asks for: "
    "the one declaration of this file a fork edits, and the adapt wizard's "
    "check empties it by name, so it cannot move to a csvd/ tree",
)
_PROMPT_VOCABULARY = "tests/pipeline/test_prompt_vocabulary.py"

_ALLOWED: dict[tuple[str, str], _Excuse] = {
    ("pipeline/pdf_retrieval.py", "csvd-dashboard"): _declared(
        "PMC_IDCONV_TOOL", "the tool name NCBI knows the pipeline by"
    ),
    ("pipeline/clinvar_fetch.py", "HTRA1"): _prose(_MEASURED_COUNT),
    ("pipeline/clinvar_fetch.py", "NOTCH3"): _prose(_MEASURED_COUNT),
    ("pipeline/clinvar_fetch.py", "TREX1"): _prose(_MEASURED_COUNT),
    ("pipeline/citations.py", "NOTCH3"): _prose(
        "worked example for the single-sentence rule"
    ),
    ("pipeline/config.py", "NOTCH3"): _prose(_MEASURED_COUNT),
    ("pipeline/config.py", "HTRA1"): _prose(
        "comment quoting a measured Open Targets association count"
    ),
    ("pipeline/orphadata_fetch.py", "HTRA1"): _prose(
        "comment recording a verified endpoint probe and real OMIM numbers"
    ),
    ("pipeline/export/omim.py", "AD"): _prose(
        "OMIM's inheritance code (autosomal dominant), not a disease: no term "
        "upstream, and the short form of more than one disease a fork may be for"
    ),
    ("pipeline/annotations.py", "C6orf195"): _RETIRED_SYMBOL,
    ("pipeline/annotations.py", "LINC01600"): _RETIRED_SYMBOL,
    ("pipeline/clinvar_fetch.py", "C6orf195"): _RETIRED_SYMBOL,
    ("pipeline/clinvar_fetch.py", "LINC01600"): _RETIRED_SYMBOL,
    ("pipeline/data_merger.py", "C6orf195"): _RETIRED_SYMBOL,
    ("pipeline/data_merger.py", "LINC01600"): _RETIRED_SYMBOL,
    ("pipeline/ncbi_http.py", "C6orf195"): _RETIRED_SYMBOL,
    ("pipeline/ncbi_http.py", "LINC01600"): _RETIRED_SYMBOL,
    ("pipeline/uniprot_fetch.py", "C6orf195"): _RETIRED_SYMBOL,
    ("pipeline/uniprot_fetch.py", "LINC01600"): _RETIRED_SYMBOL,
    ("pipeline/extraction_models.py", "PVWMH"): _MEASURED_TRAIT,
    ("pipeline/extraction_models.py", "ICH-non-lobar"): _MEASURED_TRAIT,
    ("pipeline/export/tables.py", "ICH-non-lobar"): _MEASURED_TRAIT,
    (_PROMPT_VOCABULARY, "CMB"): _FORK_EDIT_POINT,
    (_PROMPT_VOCABULARY, "NODDI"): _FORK_EDIT_POINT,
    (_PROMPT_VOCABULARY, "lacunar stroke"): _FORK_EDIT_POINT,
    (_PROMPT_VOCABULARY, "MTAG (all ICH, SVS, WMH, FA, MD, AD)"): _FORK_EDIT_POINT,
    (_PROMPT_VOCABULARY, "ICH"): _FORK_EDIT_POINT,
    (_PROMPT_VOCABULARY, "non-lobar ICH"): _FORK_EDIT_POINT,
    (_PROMPT_VOCABULARY, "All ICH & lobar ICH only"): _FORK_EDIT_POINT,
    (_PROMPT_VOCABULARY, "lacunes (suggestive significance)"): _FORK_EDIT_POINT,
}


# A place in a source: its line, counted from 1, and its column in characters.
_Point = tuple[int, int]
_Span = tuple[_Point, _Point]


class _Layout:
    """Where a Python source keeps its prose, and where each name is assigned.

    Each is a span of the text, not a set of lines: a second statement on a
    docstring's line, or after an assignment on its last, is outside it.
    """

    def __init__(self, source: str) -> None:
        tree = ast.parse(source)
        lines = source.split("\n")

        def span(node: ast.stmt) -> _Span:
            # ast counts a column in UTF-8 bytes, a match in characters.
            def point(number: int, column: int) -> _Point:
                line = lines[number - 1].encode("utf-8")
                return number, len(line[:column].decode("utf-8"))

            return (
                point(node.lineno, node.col_offset),
                point(node.end_lineno or node.lineno, node.end_col_offset or 0),
            )

        # A string that is a statement of its own: a docstring.
        self._docstrings = [
            span(node)
            for node in ast.walk(tree)
            if isinstance(node, ast.Expr)
            and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str)
        ]
        # The column each line's comment starts at.
        self._comments = {
            token.start[0]: token.start[1]
            for token in tokenize.generate_tokens(io.StringIO(source).readline)
            if token.type == tokenize.COMMENT
        }
        # Module level only: a local of the same name is another variable.
        self._assignments: dict[str, list[_Span]] = {}
        for node in tree.body:
            if isinstance(node, ast.Assign):
                targets = node.targets
            elif isinstance(node, ast.AnnAssign):
                targets = [node.target]
            else:
                continue
            for target in targets:
                if isinstance(target, ast.Name):
                    self._assignments.setdefault(target.id, []).append(span(node))

    def prose(self, number: int, start: int, end: int) -> bool:
        """Whether columns *start* to *end* of line *number* are in a comment
        or a docstring."""
        comment = self._comments.get(number)
        if comment is not None and comment <= start:
            return True
        return _within(self._docstrings, number, start, end)

    def assigns(self, name: str, number: int, start: int, end: int) -> bool:
        """Whether columns *start* to *end* of line *number* are in a
        module-level assignment to *name*."""
        return _within(self._assignments.get(name, ()), number, start, end)


def _within(spans: Iterable[_Span], number: int, start: int, end: int) -> bool:
    return any(
        first <= (number, start) and (number, end) <= last for first, last in spans
    )


def _lines(path: Path) -> list[str]:
    """The file's lines as Python numbers them.

    Split on the newline alone: `str.splitlines` also breaks at a form feed
    and at the Unicode separators, which `ast` and `tokenize` do not, and
    every line after one would be numbered apart from its `_Layout`.
    """
    return path.read_text(encoding="utf-8").split("\n")


@cache
def _layout(rel: str) -> _Layout:
    assert rel.endswith(".py"), (
        f"_ALLOWED has an entry for {rel}: an entry is read as Python, and "
        "this is not a .py file. Reword the line instead."
    )
    return _Layout((_ROOT / rel).read_text(encoding="utf-8"))


def _excused(rel: str, number: int, match: re.Match[str]) -> bool:
    """Whether the allow-list excuses the term *match* found on this line."""
    excuse = _ALLOWED.get((rel, match.group(0)))
    if excuse is None:
        return False
    layout = _layout(rel)
    if excuse.declaration is not None:
        return layout.assigns(excuse.declaration, number, match.start(), match.end())
    return layout.prose(number, match.start(), match.end())


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


def _term_matcher(
    caseless: Iterable[str], exact: Iterable[str]
) -> Callable[[str], list[re.Match[str]]]:
    """Where a line names the terms, each match as written in it.

    A name is prose and matches in any case. An abbreviation, a short form or
    a gene symbol is an identifier whose case is its meaning -- "PD" is not
    ``import pandas as pd``, "APP" not "the app", "MS" not a millisecond
    parameter -- so it matches as written.
    """
    names = _whole_words(caseless, re.IGNORECASE)
    identifiers = _whole_words(exact)

    def matches(line: str) -> list[re.Match[str]]:
        found = list(names.finditer(line)) if names is not None else []
        if identifiers is None:
            return found
        # An identifier inside a name already found is part of that name: a
        # trait's spelled-out name can hold another trait's key.
        spans = [match.span() for match in found]
        found.extend(
            match
            for match in identifiers.finditer(line)
            if not any(a <= match.start() and match.end() <= b for a, b in spans)
        )
        return found

    return matches


def _term_finder(
    caseless: Iterable[str], exact: Iterable[str]
) -> Callable[[str], list[str]]:
    """The terms a line names, as `_term_matcher` finds them."""
    matches = _term_matcher(caseless, exact)
    return lambda line: [match.group(0) for match in matches(line)]


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
    matches = _term_matcher(
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
            for number, line in enumerate(_lines(path), 1):
                for match in matches(line):
                    if _excused(rel, number, match):
                        continue
                    term = match.group(0)
                    hit = f"{rel}:{number}: {line.strip()}"
                    if (excuse := _ALLOWED.get((rel, term))) is not None:
                        hit += f"  [{term} is excused there only {excuse.where}]"
                    hits.append(hit)
    return hits


def test_no_disease_literal_remains_outside_disease() -> None:
    assert _hits(_ROOTS, lambda path: False, _manifest_terms()) == [], (
        "Reword each line so it names no term of the disease, or, when the "
        "text means something else (a quoted measurement, a tool name), add "
        "an entry to _ALLOWED in tests/pipeline/test_no_disease_literals.py: "
        "the file, the term as written, and the reason in _prose (a comment "
        "or a docstring) or _declared (the one assignment that holds it)."
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
        "the file, the term as written, and the reason in _prose (a comment "
        "or a docstring) or _declared (the one assignment that holds it)."
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
        "written, and the reason in _prose (a comment or a docstring) or "
        "_declared (the one assignment that holds it)."
    )


def test_an_allow_list_entry_excuses_its_term_only_where_it_says(
    tmp_path, monkeypatch
) -> None:
    source = tmp_path / "src" / "module.py"
    source.parent.mkdir()
    source.write_text(
        '"""Module docstring quoting QUOTED1."""\n'  # 1
        "# A comment quoting QUOTED1.\n"  # 2
        "x = 1  # a trailing comment quoting QUOTED1\n"  # 3
        'y = "QUOTED1"\n'  # 4
        'z = "QUOTED1"  # and QUOTED1 again\n'  # 5
        "def f():\n"  # 6
        '    """A docstring of several lines.\n'  # 7
        "\n"  # 8
        "    QUOTED1 on its last.\n"  # 9
        '    """\n'  # 10
        '    return """a string a statement uses:\n'  # 11
        '    QUOTED1"""\n'  # 12
        "KEPT: dict[str, str] = {\n"  # 13
        '    "KEYED1": "why",  # KEYED1 in a comment of the declaration\n'  # 14
        "}\n"  # 15
        'other = {"KEYED1": 1}\n'  # 16
        "# KEYED1 in a comment outside it\n"  # 17
        'KEPT["KEYED1"]\n'  # 18
        "def g():\n"  # 19
        '    KEPT = "KEYED1"\n'  # 20
        "# A form feed \x0c and a line separator \u2028 are not line ends.\n"  # 21
        'w = "QUOTED1"\n'  # 22
        '"""A bare string after them, quoting QUOTED1."""\n'  # 23
        # A statement beside a docstring or an assignment is not part of it.
        '"""QUOTED1"""; v = "QUOTED1"  # QUOTED1\n'  # 24
        'def h(): u = "QUOTED1"; """QUOTED1"""\n'  # 25
        'KEPT = {"KEYED1": 2}; t = "KEYED1"\n'  # 26
        # ast counts a column in bytes: ten two-byte letters end the first
        # statement six characters sooner than their bytes would.
        f'KEPT = "{"\u00e9" * 10}";"KEYED1"\n',  # 27
        encoding="utf-8",
    )
    monkeypatch.setattr(f"{__name__}._ROOT", tmp_path)
    monkeypatch.setattr(
        f"{__name__}._ALLOWED",
        {
            ("src/module.py", "QUOTED1"): _prose("a quoted measurement"),
            ("src/module.py", "KEYED1"): _declared("KEPT", "a key the code needs"),
        },
    )
    _layout.cache_clear()
    try:
        hits = _hits(("src",), lambda path: False, ([], ["QUOTED1", "KEYED1"]))
    finally:
        _layout.cache_clear()

    prose_only = "[QUOTED1 is excused there only in a comment or a docstring]"
    declared_only = (
        "[KEYED1 is excused there only inside the module-level assignment to KEPT]"
    )
    assert hits == [
        f'src/module.py:4: y = "QUOTED1"  {prose_only}',
        # Once, for the code: the comment excuses its own QUOTED1 alone.
        f'src/module.py:5: z = "QUOTED1"  # and QUOTED1 again  {prose_only}',
        f'src/module.py:12: QUOTED1"""  {prose_only}',
        f'src/module.py:16: other = {{"KEYED1": 1}}  {declared_only}',
        f"src/module.py:17: # KEYED1 in a comment outside it  {declared_only}",
        f'src/module.py:18: KEPT["KEYED1"]  {declared_only}',
        f'src/module.py:20: KEPT = "KEYED1"  {declared_only}',
        f'src/module.py:22: w = "QUOTED1"  {prose_only}',
        f'src/module.py:24: """QUOTED1"""; v = "QUOTED1"  # QUOTED1  {prose_only}',
        f'src/module.py:25: def h(): u = "QUOTED1"; """QUOTED1"""  {prose_only}',
        f'src/module.py:26: KEPT = {{"KEYED1": 2}}; t = "KEYED1"  {declared_only}',
        f'src/module.py:27: KEPT = "{"\u00e9" * 10}";"KEYED1"  {declared_only}',
    ]


def _excused_lines(rel: str, term: str) -> list[int]:
    """The lines of *rel* on which the allow-list excuses *term*.

    The term is looked for by itself, not with the scans' terms: an entry may
    be for a term only a fork's manifest holds.
    """
    matches = _term_matcher([], [term])
    return [
        number
        for number, line in enumerate(_lines(_ROOT / rel), 1)
        if any(_excused(rel, number, match) for match in matches(line))
    ]


def test_every_allow_list_entry_still_excuses_a_line() -> None:
    for (rel, term), excuse in _ALLOWED.items():
        if rel.startswith(_TEST_ROOTS) and not _has_disease_trees():
            # The tests are not scanned here, so an entry for one excuses
            # nothing, and a fork has edited what it names.
            continue
        assert _excused_lines(
            rel, term
        ), f"{rel} no longer names {term} {excuse.where}"
