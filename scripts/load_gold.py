"""Load the hand-curated gold tables into the database.

The gold tables under disease/gold/out/ -- ST1's genes and ST3's trials,
cleaned out of the curators' workbook by disease/gold/clean_gold.R -- are the
ground truth, and until they have been reviewed further they are the only
rows the dashboard publishes. This replaces `genes` (its three list tables
cascade) and `clinical_trials` with them, and empties `pubmed_refs` so that a
later run re-reads every paper against the gold genes rather than skipping
them as already processed.

    uv run python -m scripts.load_gold            # build and check only
    uv run python -m scripts.load_gold --write    # replace the rows

**Take a dump first** (`pg_dump`, the regenerate-data skill): `--write`
deletes every gene and trial the database holds, and nothing else keeps them.
Then `deno task data` publishes what this wrote.

**Every row is checked before anything is written.** The plan is refused,
naming each row, for:

- a non-empty suspects.csv -- a cell the clean-up could not vouch for;
- a trial whose registry ID has no group in `POPULATION_GROUP`, or two trials
  with one (registry ID, drug);
- a value longer than its column;
- a GWAS trait that is not a vocabulary key once the synonyms are folded;
- an omics entry, trait, monogenic link or reference the export would not
  publish exactly as built here -- the export's own `clean_gene_row` is the
  judge, so wording it would drop or rewrite is a refusal rather than a
  silently different dataset.

How a gold cell becomes a stored value:

- An ST1 column the dashboard has no column for is folded into the omics
  evidence, labelled with the study type the omics filter selects it by
  (Proteomics, WES/WGS, Proteogenomic MR, Experimental), and the
  Proteogenomic MR column also sets Mendelian randomization.
- `other_omics` is split into one study per line or ";"-segment, each
  keeping its wording and its "*" colocalization markers. Entries prose
  cannot carry are stored as a JSON array (`stored_omics`).
- The two brain-cell-type columns are joined as "Mouse: ...; Human: ...".
- Monogenic links are the six-digit OMIM numbers in the `monogenic` prose;
  references are ST1's rows of references.csv, PMIDs and DOIs as written.
- source_quote and confidence stay NULL: no extraction wrote these rows.

Three ST1 columns are deliberately not loaded: tier, the GPS druggability
score and the drug-repositioning candidate. The run history, the refreshes
and the lookup caches are left alone.

Run it as a module, not as a path: `uv run scripts/...` puts scripts/ on
sys.path rather than the repo root, and the pipeline imports below would not
resolve.
"""

import argparse
import asyncio
import csv
import json
import os
import re
import sys
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any, Final

from dotenv import load_dotenv
from scripts.restore_from_json import (
    _TRIAL_COLUMNS,
    GeneRestore,
    _advance_sequence,
    _insert,
    export_gene,
    insert_genes,
    stored_omics,
)

from pipeline.database import Database
from pipeline.disease import VOCABULARY_PATH
from pipeline.export.tables import (
    clean_omics_value,
    clean_trial_row,
    publishable_traits,
)

_ROOT: Final = Path(__file__).resolve().parent.parent
_GOLD_DIR: Final = _ROOT / "disease" / "gold" / "out"


class GoldRefused(Exception):
    """The gold tables cannot be loaded faithfully."""


@dataclass(frozen=True)
class GoldPlan:
    genes: list[GeneRestore]
    trials: list[dict[str, Any]]


# The curators' target-population group for each gold trial, keyed by
# registry ID: ST3 states only the free-text population, and these are the
# groups the curated table already gave the same trials, approved in the PR.
POPULATION_GROUP: Final[Mapping[str, str]] = MappingProxyType(
    {
        "ChiCTR2500109773": "Stroke",
        "ISRCTN14632228": "Stroke",
        "ISRCTN44436843": "Stroke",
        "NCT06530537": "Stroke",
        "NCT06674460": "Stroke",
        "NCT05755997": "SVD",
        "NCT04658823": "SVD",
        "NCT06814730": "SVD",
        "ChiCTR2400094236": "Cognitive Impairment",
        "NCT05356104": "Cognitive Impairment",
        "NCT07026994": "CAA",
        "NCT06393712": "CAA",
        "ACTRN12624001477516": "CAA",
    }
)

# Every bounded column a gold value lands in, and its width, from the
# migrations (001, 005, 014, 016). The rest are TEXT or INTEGER.
_GENE_WIDTHS: Final[Mapping[str, int]] = MappingProxyType(
    {
        "protein": 255,
        "gene": 100,
        "chromosomal_location": 50,
        "brain_cell_types": 255,
    }
)
_LIST_WIDTHS: Final[Mapping[str, int]] = MappingProxyType(
    {"traits": 100, "links": 20, "references": 100}
)
_TRIAL_WIDTHS: Final[Mapping[str, int]] = MappingProxyType(
    {
        "drug": 255,
        "genetic_target": 255,
        "genetic_evidence": 10,
        "registry_id": 50,
        "clinical_trial_phase": 20,
        "target_population": 100,
        "estimated_completion_date": 20,
        "sponsor_type": 100,
    }
)


def _blank(value: str | None) -> str | None:
    stripped = (value or "").strip()
    return stripped or None


def _read_csv(path: Path) -> list[dict[str, str]]:
    # utf-8-sig: the gold export writes a byte-order mark before the header.
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


# --------------------------------------------------------------------- genes

_OMIM_NUMBER: Final = re.compile(r"\b\d{6}\b")
_OUTSIDE_PARENS: Final = r"(?![^(]*\))"
_TRAIT_SEPARATOR: Final = re.compile(rf"[,;]{_OUTSIDE_PARENS}")
_STUDY_SEPARATOR: Final = re.compile(rf"\n|;{_OUTSIDE_PARENS}")

# A study that leads with its type: "TWAS AIS: tissue*" is the TWAS
# "AIS: tissue*". The type takes the omics filter's spelling.
_LEADING_TYPE: Final = re.compile(
    r"^(TWAS|PWAS|EWAS|proteomics)\b\s*:?\s*(.*)$", re.IGNORECASE | re.DOTALL
)
_TYPE_SPELLING: Final[Mapping[str, str]] = MappingProxyType(
    {"twas": "TWAS", "pwas": "PWAS", "ewas": "EWAS", "proteomics": "Proteomics"}
)
# A study named by its method rather than by a type: the whole sentence is
# the detail, under the type the method belongs to.
_METHOD_TYPE: Final = (
    ("sequencing", "WES/WGS"),
    ("multiancestry fine-mapping", "Fine-mapping"),
)
_PARENTHESISED: Final = re.compile(r"^\(([^()]*)\)$")


def _study_entry(study: str) -> str:
    """One `other_omics` study in the wire form "Type;detail"."""
    if match := _LEADING_TYPE.match(study):
        kind = _TYPE_SPELLING[match.group(1).lower()]
        detail = match.group(2).strip()
        if inner := _PARENTHESISED.match(detail):
            detail = inner.group(1).strip()
        return f"{kind};{detail}" if detail else kind
    for method, kind in _METHOD_TYPE:
        if study.lower().startswith(method):
            return f"{kind};{study}"
    # A sentence the export already knows the type of (its MENTR sentence)
    # keeps its wording as the detail. Anything else is returned as it is,
    # and the plan refuses it: no filter could reach it.
    named = clean_omics_value(study)
    if len(named) == 1 and ";" not in named[0] and named[0] != "(none found)":
        return f"{named[0]};{study}"
    return study


def _omics_entries(row: Mapping[str, str]) -> list[str]:
    entries = [
        _study_entry(study)
        for part in _STUDY_SEPARATOR.split(row["other_omics"])
        if (study := part.strip().rstrip(",;").strip())
    ]
    for kind, column in (
        ("Proteomics", "proteomic_trait"),
        ("WES/WGS", "ngs_rare_deleterious_or_protective_variant"),
        ("Proteogenomic MR", "proteogenomics_mr"),
        ("Experimental", "other_incl_experimental"),
    ):
        if detail := _blank(row[column]):
            entries.append(f"{kind};{detail}")
    return entries


def _raw_traits(cell: str) -> list[str]:
    return [t for part in _TRAIT_SEPARATOR.split(cell) if (t := part.strip())]


def _cell_types(mice: str, human: str) -> str | None:
    sides = [
        f"{species}: {value}"
        for species, value in (("Mouse", _blank(mice)), ("Human", _blank(human)))
        if value
    ]
    return "; ".join(sides) or None


def gene_from_gold(row: Mapping[str, str], references: Sequence[str]) -> GeneRestore:
    """One ST1 row, and its references in order, as stored rows."""
    return GeneRestore(
        columns={
            "protein": _blank(row["protein"]),
            "gene": row["gene"].strip(),
            "chromosomal_location": _blank(row["chr_location"]),
            "mendelian_randomization": _blank(row["proteogenomics_mr"]) is not None,
            "evidence_from_other_omics_studies": (
                stored_omics(entries) if (entries := _omics_entries(row)) else None
            ),
            "brain_cell_types": _cell_types(
                row["brain_cell_types_mice"], row["brain_cell_types_human"]
            ),
            "affected_pathway": _blank(row["pathway_goa_function"]),
            "source_quote": None,
            "confidence": None,
        },
        traits=publishable_traits(_raw_traits(row["gwas_trait"])),
        links=list(dict.fromkeys(_OMIM_NUMBER.findall(row["monogenic"]))),
        references=list(references),
    )


def _gene_failures(
    row: Mapping[str, str], gene: GeneRestore, trait_keys: frozenset[str]
) -> list[str]:
    failures = [
        f"GWAS trait {trait!r} is not in the vocabulary"
        for trait in _raw_traits(row["gwas_trait"])
        if not set(publishable_traits([trait])) & trait_keys
    ]
    failures += [
        f"{column} is {len(value)} characters, over {width}"
        for column, width in _GENE_WIDTHS.items()
        if (value := gene.columns[column]) is not None and len(value) > width
    ]
    failures += [
        f"{attribute} value {value!r} is over {width} characters"
        for attribute, width in _LIST_WIDTHS.items()
        for value in getattr(gene, attribute)
        if len(value) > width
    ]
    published = export_gene(gene)
    for key, built in (
        ("evidenceFromOtherOmicsStudies", _omics_entries(row) or ["(none found)"]),
        ("gwasTrait", gene.traits or ["(none found)"]),
        ("linkToMonogenicDisease", gene.links or ["(none found)"]),
        ("references", gene.references or ["(reference needed)"]),
    ):
        if published[key] != built:
            lost = [entry for entry in built if entry not in published[key]]
            failures.append(f"the export would not publish {key} {lost!r}")
    return failures


# ------------------------------------------------------------ clinical trials


def _completion(row: Mapping[str, str]) -> str | None:
    """`M/YYYY`, the wire form of every other date in the table, or the
    curators' note when ST3 gives no date."""
    if date := _blank(row["estimated_completion"]):
        year, month = date.split("-")
        return f"{int(month)}/{year}"
    return _blank(row["completion_note"])


def trial_from_gold(row: Mapping[str, str]) -> dict[str, Any]:
    """One ST3 row as a stored clinical_trials row, in `_TRIAL_COLUMNS` order."""
    registry_id = row["registry_id"].strip()
    if registry_id not in POPULATION_GROUP:
        raise GoldRefused(
            f"trial {registry_id}: no target-population group in POPULATION_GROUP"
        )
    target_n = _blank(row["target_n"])
    return {
        "drug": _blank(row["agent"]),
        "mechanism_of_action": _blank(row["mechanism_of_action"]),
        "genetic_target": _blank(row["genetic_target"]),
        "genetic_evidence": _blank(row["genetic_evidence"]),
        "trial_name": _blank(row["trial_name"]),
        "registry_id": registry_id,
        "clinical_trial_phase": _blank(row["trial_phase"]),
        "target_population": POPULATION_GROUP[registry_id],
        "target_population_details": _blank(row["population"]),
        "target_sample_size": None if target_n is None else int(target_n),
        "estimated_completion_date": _completion(row),
        "primary_outcome": _blank(row["trial_primary_outcome"]),
        "sponsor_type": _blank(row["trial_sponsor_type"]),
        "overall_status": None,
    }


# --------------------------------------------------------------------- plan


def build_gold_plan(gold_dir: Path) -> GoldPlan:
    """Every row to write, or GoldRefused naming each row that cannot be."""
    failures: list[str] = []
    if suspects := _read_csv(gold_dir / "suspects.csv"):
        failures.append(
            f"suspects.csv lists {len(suspects)} cell(s) the clean-up could "
            "not vouch for; resolve them in disease/gold first"
        )

    references: defaultdict[str, list[tuple[int, str]]] = defaultdict(list)
    for ref in _read_csv(gold_dir / "references.csv"):
        if ref["sheet"] == "ST1":
            references[ref["source_row"]].append((int(ref["position"]), ref["id"]))

    vocabulary = json.loads(VOCABULARY_PATH.read_text(encoding="utf-8"))
    trait_keys = frozenset(trait["key"] for trait in vocabulary["traits"])
    genes: list[GeneRestore] = []
    seen_genes: set[str] = set()
    for row in _read_csv(gold_dir / "st1_genes.csv"):
        ids = [ref_id for _, ref_id in sorted(references[row["source_row"]])]
        gene = gene_from_gold(row, ids)
        symbol = gene.columns["gene"]
        if symbol.upper() in seen_genes:
            failures.append(f"gene {symbol}: duplicate gene")
        seen_genes.add(symbol.upper())
        failures += [
            f"gene {symbol}: {failure}"
            for failure in _gene_failures(row, gene, trait_keys)
        ]
        genes.append(gene)

    trials: list[dict[str, Any]] = []
    seen_trials: set[tuple[str, str | None]] = set()
    for row in _read_csv(gold_dir / "st3_trials.csv"):
        try:
            trial = trial_from_gold(row)
        except GoldRefused as exc:
            failures.append(str(exc))
            continue
        name = f"trial {trial['registry_id']} / {trial['drug']}"
        key = (trial["registry_id"], trial["drug"])
        if key in seen_trials:
            failures.append(f"{name}: duplicate (registry_id, drug)")
        seen_trials.add(key)
        failures += [
            f"{name}: {column} is {len(value)} characters, over {width}"
            for column, width in _TRIAL_WIDTHS.items()
            if (value := trial[column]) is not None and len(value) > width
        ]
        clean_trial_row(dict(trial))  # raises on a row the export cannot read
        trials.append(trial)

    if failures:
        raise GoldRefused(
            "The gold tables cannot be loaded as they are:\n  "
            + "\n  ".join(failures)
        )
    return GoldPlan(genes=genes, trials=trials)


# -------------------------------------------------------------------- write

# What write_gold_plan replaces. The list tables cascade from genes.
_REPLACED_TABLES: Final = ("genes", "clinical_trials", "pubmed_refs")
_COUNTED_TABLES: Final = (
    "genes",
    "gene_gwas_traits",
    "gene_monogenic_links",
    "gene_references",
    "clinical_trials",
    "pubmed_refs",
)


async def write_gold_plan(plan: GoldPlan) -> dict[str, int]:
    """Replace the genes and trials with the plan's, in one transaction, so a
    failure leaves the database as it was."""
    async with Database.connection() as conn, conn.transaction():
        for table in _REPLACED_TABLES:
            # Interpolating is safe: every name is a module constant.
            await conn.execute(f"DELETE FROM {table}")
        await insert_genes(conn, plan.genes)
        await conn.executemany(
            _insert("clinical_trials", ["id", *_TRIAL_COLUMNS]),
            [
                (trial_id, *(trial[c] for c in _TRIAL_COLUMNS))
                for trial_id, trial in enumerate(plan.trials, start=1)
            ],
        )
        await _advance_sequence(conn, "clinical_trials")
        return {
            table: await conn.fetchval(f"SELECT count(*) FROM {table}")
            for table in _COUNTED_TABLES
        }


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Replace the genes and trials with the gold tables."
    )
    parser.add_argument(
        "--write",
        action="store_true",
        help="write into the database .env names (default: check only)",
    )
    args = parser.parse_args(argv)

    try:
        plan = build_gold_plan(_GOLD_DIR)
    except GoldRefused as exc:
        sys.exit(str(exc))

    # Loaded here rather than at import, so importing this module -- as the
    # tests do -- never puts the real .env's credentials in the environment.
    load_dotenv(_ROOT / ".env")
    target = (
        f"{os.getenv('DB_NAME') or '(DB_NAME unset)'} on "
        f"{os.getenv('DB_HOST') or '(DB_HOST unset)'}:{os.getenv('DB_PORT', '5432')}"
    )
    print(
        f"{len(plan.genes)} genes, {len(plan.trials)} trials; every row "
        "publishes as built."
    )
    print(f"Target database: {target}")
    if not args.write:
        print("Nothing written; pass --write to replace the genes and trials.")
        return

    async def _write() -> dict[str, int]:
        try:
            return await write_gold_plan(plan)
        finally:
            await Database.close()

    for table, count in asyncio.run(_write()).items():
        print(f"{table}: {count} rows")


if __name__ == "__main__":
    main()
