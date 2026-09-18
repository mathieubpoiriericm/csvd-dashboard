"""No disease term survives in pipeline/ or scripts/ outside disease/."""

import re
from pathlib import Path

from pipeline.disease import load_disease

_ROOT = Path(__file__).resolve().parents[2]
_ROOTS = ("pipeline", "scripts")

# (relative path, term) -> reason. Whole-word matching means SVDPMIDTOKEN
# and _svd_started_monotonic never match and need no entry.
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
        "scripts/timeline_figure.py",
        "svd",
    ): "CSS custom-property namespace (--svd-figure-ink), an internal "
    "identifier nobody reads",
}


def test_no_disease_literal_remains_outside_disease() -> None:
    d = load_disease()
    # "csvd-dashboard" goes first: alternation tries each term in order at a
    # given start, so with the abbreviation ahead of it, "csvd-dashboard"
    # would only ever match as the plain abbreviation "csvd", never as the
    # full tool name the allow-list below names.
    terms = ["csvd-dashboard", d.name, d.abbreviation, d.short, *d.monogenic_genes]
    pattern = re.compile(
        r"\b(" + "|".join(re.escape(t) for t in terms) + r")\b", re.IGNORECASE
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
                for match in pattern.finditer(line):
                    if (rel, match.group(0)) in _ALLOWED:
                        continue
                    hits.append(f"{rel}:{number}: {line.strip()}")
    assert hits == []


def test_every_allow_list_entry_is_still_needed() -> None:
    for (rel, term), _reason in _ALLOWED.items():
        text = (_ROOT / rel).read_text(encoding="utf-8")
        assert re.search(
            rf"\b{re.escape(term)}\b", text
        ), f"{rel} no longer names {term}"
