"""No disease term survives in pipeline/ or scripts/ outside disease/."""

import re
from collections.abc import Callable, Iterable
from pathlib import Path

from pipeline.disease import load_disease

_ROOT = Path(__file__).resolve().parents[2]
_ROOTS = ("pipeline", "scripts")

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
}


def _whole_words(terms: Iterable[str], flags: int = 0) -> re.Pattern[str] | None:
    alternatives = [re.escape(term.strip()) for term in terms if term.strip()]
    if not alternatives:
        return None
    return re.compile(r"\b(?:" + "|".join(alternatives) + r")\b", flags)


def _term_finder(
    caseless: Iterable[str], exact: Iterable[str]
) -> Callable[[str], list[str]]:
    """The terms a line names, as written in it.

    A name is prose and matches in any case. An abbreviation, a short form or
    a gene symbol is an identifier whose case is its meaning -- "PD" is not
    ``import pandas as pd``, "APP" not "the app", "MS" not a millisecond
    parameter -- so it matches as written.
    """
    patterns = [
        pattern
        for pattern in (
            _whole_words(caseless, re.IGNORECASE),
            _whole_words(exact),
        )
        if pattern is not None
    ]

    def find(line: str) -> list[str]:
        return [m.group(0) for p in patterns for m in p.finditer(line)]

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


def test_no_disease_literal_remains_outside_disease() -> None:
    d = load_disease()
    # "csvd-dashboard" goes first: alternation tries each term in order at a
    # given start, so with a shorter term ahead of it that it begins with,
    # "csvd-dashboard" would only ever match as that term, never as the full
    # tool name the allow-list above names.
    find = _term_finder(
        ["csvd-dashboard", d.name],
        [
            d.abbreviation,
            d.short,
            *d.monogenic_genes,
            *d.gene_aliases,
            *(member for members in d.gene_aliases.values() for member in members),
        ],
    )
    hits: list[str] = []
    for root in _ROOTS:
        for path in sorted((_ROOT / root).rglob("*")):
            if path.suffix not in {".py", ".j2"} or "alembic/versions" in str(path):
                continue
            rel = path.relative_to(_ROOT).as_posix()
            for number, line in enumerate(
                path.read_text(encoding="utf-8").splitlines(), 1
            ):
                for term in find(line):
                    if (rel, term) in _ALLOWED:
                        continue
                    hits.append(f"{rel}:{number}: {line.strip()}")
    assert hits == [], (
        "Reword each line so it names no term of the disease, or, when the "
        "text means something else (a quoted measurement, a tool name), add "
        "an entry to _ALLOWED in tests/pipeline/test_no_disease_literals.py: "
        "the file, the term as written and the reason."
    )


def test_every_allow_list_entry_is_still_needed() -> None:
    for (rel, term), _reason in _ALLOWED.items():
        text = (_ROOT / rel).read_text(encoding="utf-8")
        assert re.search(
            rf"\b{re.escape(term)}\b", text
        ), f"{rel} no longer names {term}"
