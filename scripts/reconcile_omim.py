"""Compare the curated OMIM links against the machine-fetched ones.

The dashboard has published a gene's monogenic-disease OMIM number two ways
for as long as it has existed. The curated way is `gene_monogenic_links`, one
row per value since migration 006 split it out of the free-text
`genes.link_to_monogenetic_disease` column; the export publishes those rows
verbatim into `linkToMonogenicDisease` and the browser joins them against
`disease/omim_info.csv` -- a 49-row UTF-8 file maintained by hand.
The machine way is `data/gene_annotations.json`, where the same number arrives
from ClinVar as a typed field beside MONDO, Orphanet and MedGen identifiers.

This prints where the two disagree. **It is a report, not a migration**: the
CSV is curated data, and the `genes.references` corruption this repo already
documents is what happens when curated values are transformed without review.
Nothing here writes anything.

Three disagreements are worth different things:

- *Curated only* -- the curator recorded an OMIM number ClinVar does not
  return for that gene. Often correct and simply older or broader than
  ClinVar's variant-level evidence; occasionally a transcription slip.
- *Fetched only* -- ClinVar attests a disease the curated column does not
  mention. A candidate addition, not an error.
- *Differing* -- both name a number and they are not the same. The only class
  that always needs a human.

Usage:
    uv run scripts/reconcile_omim.py
    uv run scripts/reconcile_omim.py --annotations data/gene_annotations.json
"""

import argparse
import json
import re
import sys
from collections.abc import Iterable
from pathlib import Path
from typing import Any, NamedTuple

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TABLE1 = PROJECT_ROOT / "data" / "table1.json"
DEFAULT_ANNOTATIONS = PROJECT_ROOT / "data" / "gene_annotations.json"

# The export publishes gene_monogenic_links verbatim, so a curated row may
# carry prose around its number ("CADASIL (125310)"). This is the pattern
# scripts/backfill_gene_lists.py mined the pre-006 column with, applied here
# to the published strings rather than to the database.
_OMIM_ID = re.compile(r"\b\d{6}\b")


class Disagreement(NamedTuple):
    """One gene's curated and fetched OMIM numbers, where they differ."""

    gene: str
    curated: tuple[str, ...]
    fetched: tuple[str, ...]


def curated_omim_ids(rows: Iterable[dict[str, Any]]) -> dict[str, set[str]]:
    """Six-digit numbers the curated column names, per gene.

    Reads the published `linkToMonogenicDisease` rather than the database
    column, so this reports on exactly what the dashboard shows. The
    "(none found)" sentinel carries no digits and contributes nothing.
    """
    found: dict[str, set[str]] = {}
    for row in rows:
        values = row.get("linkToMonogenicDisease") or []
        ids = {
            match
            for value in values
            for match in _OMIM_ID.findall(str(value))
        }
        found[str(row["gene"])] = ids
    return found


def fetched_omim_ids(rows: Iterable[dict[str, Any]]) -> dict[str, set[str]]:
    """OMIM numbers ClinVar attests, per gene.

    Only `omimId` -- the identifier of the disease on the row. `relatedXrefs`
    holds codes another authority maps to a *different* concept, and
    `omimSeries` holds phenotypic series, which name a group rather than an
    entry; counting either here would manufacture disagreements that are not
    real, and a series can never match this script's six-digit pattern anyway.
    """
    found: dict[str, set[str]] = {}
    for row in rows:
        gene = str(row["geneSymbol"])
        omim = row.get("omimId")
        entry = found.setdefault(gene, set())
        if omim:
            entry.add(str(omim))
    return found


def reconcile(
    curated: dict[str, set[str]],
    fetched: dict[str, set[str]],
) -> tuple[list[Disagreement], list[Disagreement], list[Disagreement]]:
    """Split the genes into curated-only, fetched-only and differing."""
    curated_only: list[Disagreement] = []
    fetched_only: list[Disagreement] = []
    differing: list[Disagreement] = []

    for gene in sorted(set(curated) | set(fetched)):
        left = curated.get(gene, set())
        right = fetched.get(gene, set())
        if left == right:
            continue
        row = Disagreement(gene, tuple(sorted(left)), tuple(sorted(right)))
        if left and right:
            differing.append(row)
        elif left:
            curated_only.append(row)
        else:
            fetched_only.append(row)

    return curated_only, fetched_only, differing


def _print_section(title: str, rows: list[Disagreement], note: str) -> None:
    print(f"\n{title} ({len(rows)})")
    print("-" * len(f"{title} ({len(rows)})"))
    print(f"{note}\n")
    if not rows:
        print("  (none)")
        return
    for row in rows:
        curated = ", ".join(row.curated) or "-"
        fetched = ", ".join(row.fetched) or "-"
        print(f"  {row.gene:12s} curated: {curated:22s} fetched: {fetched}")


def main(argv: list[str] | None = None) -> int:
    """Print the reconciliation report. Always returns 0 -- this is a report."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--table1", type=Path, default=DEFAULT_TABLE1)
    parser.add_argument("--annotations", type=Path, default=DEFAULT_ANNOTATIONS)
    args = parser.parse_args(argv)

    curated = curated_omim_ids(json.loads(args.table1.read_text()))
    fetched = fetched_omim_ids(json.loads(args.annotations.read_text()))
    curated_only, fetched_only, differing = reconcile(curated, fetched)

    print("OMIM reconciliation: curated column vs machine-fetched annotations")
    print(f"genes in the curated table: {len(curated)}")
    with_omim = sum(1 for numbers in fetched.values() if numbers)
    print(f"genes ClinVar returned an OMIM number for: {with_omim}")

    _print_section(
        "Curated only",
        curated_only,
        "The curator names an OMIM number ClinVar does not return for this\n"
        "gene. Often older or broader than variant-level evidence; review.",
    )
    _print_section(
        "Fetched only",
        fetched_only,
        "ClinVar attests a disease the curated column does not mention.\n"
        "A candidate addition, not an error.",
    )
    _print_section(
        "Differing",
        differing,
        "Both name a number and they disagree. This class always needs a\n"
        "human.",
    )

    print("\nNothing was written. Retiring the curated CSV is a curation")
    print("decision that starts from this report.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
