"""Row-level cleaning for the two exported tables.

Ported from data-prep/clean_table1.R and clean_table2.R. The omics chain's
step order is load-bearing: the debris sweep runs against the *source*
separators, before ":" becomes ";" and long before the tissue names are
deleted, so it cannot be reordered or merged.
"""

import json
import logging
import re
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Final

from pipeline.disease import VOCABULARY_PATH
from pipeline.export.text import (
    clean_column_name,
    fill_missing_text,
    normalize_text,
    normalize_yes_no,
)

logger = logging.getLogger(__name__)

# The six-digit OMIM entry number, as the curated
# `genes.link_to_monogenetic_disease` prose carried it before migration 006
# split that column into `gene_monogenic_links`. Nothing in the export mines
# it any more -- `clean_gene_row` publishes the join table's rows verbatim --
# but `scripts/backfill_gene_lists.py` imports it to parse the old column, so
# the one-time backfill and the export that replaced it stay the same parser.
_OMIM_ID = re.compile(r"\b\d{6}\b")
_SPLIT_ON_COMMA = re.compile(r"\s*,\s*")
# The omics column has two writers with two grammars. The curated prose uses
# "," and ";" as study separators; the extraction writes free-text elements
# that `format_omics` joins on ";", and one element may carry a parenthetical
# list -- "Proteomics (plasma, CSF)". Splitting inside the parentheses left a
# second entry ("CSF)") with no omics type and no filter able to reach it.
# The lookahead refuses a comma followed by a ")" before any "(". GWAS traits
# keep the plain split: no trait carries parentheses.
_SPLIT_OMICS = re.compile(r"\s*,\s*(?![^(]*\))")

# The database stores whatever the curators and the extraction wrote; the
# dashboard's filters and the phenogram both key on short STRIVE-style codes.
# A synonym that never reaches that vocabulary is unreachable in the UI and
# fails the data contract test, so the known ones are rewritten here.
#
# Read from disease/vocabulary.json rather than listed: that file is the
# single source of truth for the trait vocabulary, and every consumer derives
# from it. Order is load-bearing -- these are applied in sequence as substring
# replacements, matching the long-standing SVS rewrite rather than exact match.
# Changing that would risk the byte-exact contract for no gain, so the file
# keeps `synonyms` as an ordered array.
_VOCABULARY: Final[Path] = VOCABULARY_PATH


def _load_trait_vocabulary() -> tuple[
    tuple[tuple[str, str], ...], frozenset[str]
]:
    """Load the synonym folds and untracked terms from the shared vocabulary."""
    with _VOCABULARY.open(encoding="utf-8") as handle:
        vocabulary = json.load(handle)
    rewrites = tuple(
        (entry["from"], entry["to"]) for entry in vocabulary["synonyms"]
    )
    untracked = frozenset(entry["term"] for entry in vocabulary["untracked"])
    return rewrites, untracked


# The merge drops these before storing (pipeline/data_merger.py), but rows
# written before it did are still in gene_gwas_traits -- the 2026-09-01 run
# left a curated alias-key row carrying ICH-non-lobar -- and a stored term
# with no filter choice fails tests/data_contract_test.ts. The export is the
# second layer.
_TRAIT_REWRITES, _UNTRACKED_TRAITS = _load_trait_vocabulary()


def _rewrite_trait(part: str) -> str:
    """Fold a known synonym onto the dashboard's controlled vocabulary."""
    for verbose, code in _TRAIT_REWRITES:
        part = part.replace(verbose, code)
    return part


def publishable_traits(traits: Sequence[str]) -> list[str]:
    """Fold the synonyms, drop the untracked terms, collapse what that made
    identical -- in order, so the first occurrence keeps its position.

    The fold runs first: a synonym's target is a tracked trait, so folding
    after the drop would never see it, and a fold that produces a trait
    already in the list must not publish it twice.
    """
    folded = [_rewrite_trait(trait) for trait in traits]
    return list(dict.fromkeys(t for t in folded if t not in _UNTRACKED_TRAITS))


def split_gwas_traits(value: str | None) -> list[str]:
    """Split a raw gwas_trait cell into canonical trait labels, in order.

    normalize_text runs first because clean_gene_row applied it to every
    string column before splitting: it trims the whole cell, and
    _SPLIT_ON_COMMA reaches neither the first part's leading nor the last
    part's trailing whitespace. The stored "PSMD " is a real value.

    fill_missing_text is then asked what it would call missing, rather than
    the NA/N/A set being restated here -- a value the export folds to a
    sentinel must yield no rows at all, or the sentinel input becomes a
    stored trait and publishes as ["NA"].

    Empty parts are dropped rather than emitted: the list-column contract
    requires every entry to be a nonblank string.
    """
    normalized = normalize_text(value)
    if normalized is None:
        return []
    if fill_missing_text(normalized, "(none found)") == "(none found)":
        return []
    return [_rewrite_trait(part) for part in _SPLIT_ON_COMMA.split(normalized) if part]


_EMPTY_SEPARATOR = re.compile(r";\s*(?=[,;]|$)")
_SEMICOLON_RUN = re.compile(r";\s*")
_DANGLING_SEMICOLON = re.compile(r";\s*(?=,|$)")
_DANGLING_COMMA = re.compile(r"\s*,\s*(?=,|$)")
_LEADING_COMMA = re.compile(r"^\s*,\s*")
_ALL_WORD = re.compile(r"\bALL\b")
# Verified against R's grepl(..., perl = TRUE, ignore.case = TRUE) for the
# three casing/punctuation variants clean_table2.R must normalize, plus
# near-misses (an inserted word, doubled punctuation, surrounding
# whitespace) that must NOT match -- see tests/pipeline/export/test_tables.py.
_COMPLETED_UNPUBLISHED = re.compile(
    r"^Completed\s*[,;]?\s*unpublish(?:ed)?$", re.IGNORECASE
)

_MENTR_SENTENCE: Final[str] = (
    "Evidence for causal implication from ML-based functional prediction (MENTR)"
)
_MENTR_LABEL: Final[str] = "mutation effect prediction on ncRNA transcription"

# The omics study types the dashboard can select, mirrored from
# `lib/constants.ts`'s OMICS_CHOICES minus "all" (which means "no filter").
# `lib/filters.ts` keys the omics filter on the text before the first ";" and
# compares it case- and whitespace-insensitively, so an element whose leading
# type is not in this set is published as evidence no reader can filter to --
# and fails tests/data_contract_test.ts's "every generated category is
# reachable through its filter". Nothing else gates the column: the extraction
# prompt only *suggests* labels ("colocalization", "MAGMA", "pQTL-MR"), so the
# vocabulary has to be enforced here, the way the untracked GWAS traits are.
# Reconciled against the TypeScript file by
# tests/pipeline/export/test_tables.py, so adding a choice there is what adds
# it here.
_OMICS_TYPES: Final[frozenset[str]] = frozenset(
    {
        "(none found)",
        "EWAS",
        "TWAS",
        "PWAS",
        "Proteomics",
        "WES/WGS",
        _MENTR_LABEL,
    }
)
_OMICS_TYPE_KEYS: Final[frozenset[str]] = frozenset(
    name.lower() for name in _OMICS_TYPES
)

# "Proteomics (plasma, CSF)" -- a type the vocabulary knows, wearing its
# detail as a parenthetical instead of in the wire form "<type>;<detail>".
# Anchored and refusing "(" or ";" in the head so it can only ever rewrite an
# element whose type is the leading token.
_OMICS_PARENTHETICAL = re.compile(r"^([^(;]+)\((.*)\)$")


def _omics_type(entry: str) -> str:
    """The filter key `lib/filters.ts` derives from a published element."""
    return entry.split(";")[0].strip().lower()


def _recover_omics_type(entry: str) -> str | None:
    """Rewrite "Type (detail)" into the wire form "Type;detail".

    None when the leading token is not a study type the dashboard carries,
    which is the caller's signal to drop the element rather than publish an
    unfilterable one. Only the parenthetical form is recovered: it is the
    shape the extraction actually writes, and inventing a type for prose that
    names none would be a fabricated study.
    """
    match = _OMICS_PARENTHETICAL.match(entry)
    if match is None:
        return None
    head, detail = match.group(1).strip(), match.group(2).strip()
    if head.lower() not in _OMICS_TYPE_KEYS:
        return None
    return f"{head};{detail}" if detail else head


def _publishable_omics(entries: list[str], gene: str | None) -> list[str]:
    """Keep only the elements the dashboard's omics filter can select.

    An element already in the wire form is published byte-for-byte -- this
    must not rewrite a curated value. One carrying its detail in parentheses
    is normalized to "<type>;<detail>", which keeps the detail and makes the
    type reachable. Anything else is dropped and logged per gene, the same
    disposition `pipeline/data_merger.py` gives an untracked GWAS trait: an
    unfilterable value is invisible in the UI anyway, and the log is where a
    label the dashboard ought to carry becomes findable.
    """
    published: list[str] = []
    for entry in entries:
        if _omics_type(entry) in _OMICS_TYPE_KEYS:
            published.append(entry)
            continue
        recovered = _recover_omics_type(entry)
        if recovered is not None:
            published.append(recovered)
            continue
        prefix = f"  {gene}: " if gene else "  "
        logger.info(
            f"{prefix}dropped omics evidence with no filterable study type: "
            f"'{entry}'"
        )
    return published


# clean_table1.R applies these two renames last (lines 142-154), via
# names(table1) <- gsub(old, new, names(table1), fixed = TRUE) -- a label
# change on the existing column, never a move. clean_gene_row mirrors that
# by computing every value under its original key and renaming in one final
# pass; renaming via pop()-then-reassign would silently append the key at
# the end of the dict instead of relabeling it in place, and
# pipeline/export/writer.py's write_rows preserves dict insertion order
# verbatim into the emitted JSON.
_RENAMES: Final[dict[str, str]] = {
    "Evidence from Other Omics Studies": "Evidence From Other Omics Studies",
    "Link to Monogenetic Disease": "Link to Monogenic Disease",
}

# The clinical_trials columns that fall back to "(unknown)" rather than a
# field-specific sentinel. Every name here -- like "Genetic Target" handled
# separately in clean_trial_row -- is one of the 14 columns clean_trial_row
# receives, so it is always already a key of `out` by the time the loop
# reaches it. The key order follows the database column order, where
# migration 013 appended overall_status last -- so "Overall Status" is last
# here too.
_UNKNOWN_COLUMNS: Final[tuple[str, ...]] = (
    "Drug",
    "Mechanism of Action",
    "Genetic Evidence",
    "Trial Name",
    "Registry ID",
    "Clinical Trial Phase",
    "Target Population",
    "Target Population Details",
    "Target Sample Size",
    "Estimated Completion Date",
    "Primary Outcome",
    "Sponsor Type",
    "Overall Status",
)


def clean_omics_value(value: str | None, gene: str | None = None) -> list[str]:
    """Apply the omics-evidence transformation chain, split, then gate.

    `gene` only names the row in the log line an unfilterable element writes.
    """
    text = value or ""
    text = text.replace("*", "")
    # Remove only genuinely empty separators; deleting one merely because
    # whitespace follows would merge two distinct studies.
    text = _EMPTY_SEPARATOR.sub("", text)
    text = _SEMICOLON_RUN.sub(", ", text)
    text = text.replace(":", ";")
    text = text.replace(_MENTR_SENTENCE, _MENTR_LABEL)
    text = text.replace("YFS.BLOOD.RNAARR", "")
    text = text.replace("GTEX - Cross-tissue sCCA3", "cross-tissue")
    text = text.replace("GTEx.", "")
    text = text.replace("_", " ")

    # Sweep the debris the tissue deletions leave behind. Without this an
    # entry whose whole tissue was one of those tokens keeps a separator
    # pointing at nothing ("TWAS;"), and an entry that was nothing but such
    # a token collapses to an empty list item — breaking the nonblank half
    # of the list-column contract.
    text = _DANGLING_SEMICOLON.sub("", text)
    text = _DANGLING_COMMA.sub("", text)
    text = _LEADING_COMMA.sub("", text)
    text = text.strip()

    filled = fill_missing_text(text or None, "(none found)", sentinels=())
    # Belt-and-braces, not a literal transliteration of R's strsplit (which
    # keeps empty parts): the list-column contract requires every entry to
    # be a nonblank string, so a blank split part is dropped rather than
    # emitted.
    parts = [part for part in _SPLIT_OMICS.split(filled) if part]
    # A row whose every element was unfilterable falls back to the sentinel
    # rather than to []: the list-column contract has no empty case here, and
    # "no filterable omics evidence" is what "(none found)" already says.
    return _publishable_omics(parts, gene) or ["(none found)"]


def clean_gene_row(row: dict[str, Any]) -> dict[str, Any]:
    """Clean one `genes` row into its display-keyed form."""
    values = {k: normalize_text(v) if isinstance(v, str) else v for k, v in row.items()}

    # Missing and false both mean no MR support in the source schema.
    values["mendelian_randomization"] = bool(values.get("mendelian_randomization"))

    ordered = ["gene", *[k for k in values if k != "gene"]]
    out: dict[str, Any] = {clean_column_name(k): values[k] for k in ordered}

    # The three list columns arrive already split, from their join tables.
    # `or` covers both shapes a missing list takes: [] when the reader saw
    # zero rows for a gene it did have rows for elsewhere, None when the
    # NULL placeholder came through untouched. The traits are filtered
    # before the sentinel applies, so a gene whose every stored trait is
    # untracked publishes "(none found)" rather than an empty list.
    out["GWAS Trait"] = publishable_traits(out.get("GWAS Trait") or []) or [
        "(none found)"
    ]

    # Compute under the original keys -- see _RENAMES above for why the
    # rename itself happens last, as a label change rather than a move.
    out["Evidence from Other Omics Studies"] = clean_omics_value(
        out.get("Evidence from Other Omics Studies"), out["Gene"]
    )

    out["Link to Monogenetic Disease"] = out.get("Link to Monogenetic Disease") or [
        "(none found)"
    ]

    out["References"] = out.get("References") or ["(reference needed)"]

    # Every gene the pipeline inserts stores "" here -- nothing in pipeline/
    # writes a band, the curators do (pipeline/data_merger.py) -- so without
    # this fill a newly admitted gene publishes `"chromosomalLocation": null`
    # on a string-typed, sentinel-typed field. "(unknown)" is the sentinel
    # lib/cytobands.ts already refuses to place, so the phenogram lists the
    # gene as unplaced instead of guessing a band for it.
    out["Chromosomal Location"] = fill_missing_text(
        out.get("Chromosomal Location"), "(unknown)"
    )

    # The merge stores the gene symbol when no paper named a protein, and
    # both write paths in pipeline/database.py read `protein = gene` back as
    # "still missing" so a later run can fill it. The export applies that same
    # rule rather than publishing a gene symbol in the Protein column. Exact
    # equality, as the SQL uses: "EphB4" for EPHB4 and "Epo" for EPO are real
    # protein names, written the way proteins are written.
    protein = out.get("Protein")
    out["Protein"] = fill_missing_text(
        None if protein == out["Gene"] else protein, "(unknown)"
    )

    cell_types = _ALL_WORD.sub("all", out.get("Brain Cell Types") or "")
    out["Brain Cell Types"] = fill_missing_text(cell_types or None, "(unknown)")

    out["Affected Pathway"] = fill_missing_text(
        out.get("Affected Pathway"), "(unknown)"
    ).lower()

    out["Mendelian Randomization"] = (
        "Yes" if out["Mendelian Randomization"] else "No"
    )

    # 61 of 63 curated rows predate the provenance prompt (migration 004) and
    # carry no quote; the sentinel says so plainly rather than shipping a
    # blank string or a null-valued key on a string-typed field. Confidence
    # needs no equivalent: it is a nullable number, not a sentineled string,
    # and a missing score is published as JSON null (see lib/types.ts).
    out["Source Quote"] = fill_missing_text(
        out.get("Source Quote"), "(not yet extracted)"
    )
    out["Confidence"] = out.get("Confidence")

    # Relabel in place, mirroring R's names<-(...) semantics: a rename must
    # never reorder the dict that write_rows serialises verbatim.
    return {_RENAMES.get(key, key): value for key, value in out.items()}


def clean_trial_row(row: dict[str, Any]) -> dict[str, Any]:
    """Clean one `clinical_trials` row into its display-keyed form.

    Every column this function reads or rewrites -- "Genetic Target" and
    every name in _UNKNOWN_COLUMNS -- is one of the 14 columns produced by
    the dict comprehension below, so each is already a key of `out` before
    any of the statements past it run: they are in-place value updates,
    never new-key inserts. That is why they index `out` directly rather
    than through `out.get(...)`: a row that is genuinely missing one of
    these columns raises KeyError immediately, instead of manufacturing a
    default value and silently *appending* the column at the end of the
    dict -- the same kind of silent key reorder that shipped in Task 7,
    which pipeline/export/writer.py's write_rows would serialise verbatim
    into the JSON.
    """
    values = {k: normalize_text(v) if isinstance(v, str) else v for k, v in row.items()}
    out: dict[str, Any] = {clean_column_name(k): v for k, v in values.items()}

    out["Genetic Target"] = fill_missing_text(
        out["Genetic Target"], "(none)", sentinels=("NA", "N/A", "-")
    )

    # Stringify before filling: a None sample size must become the sentinel,
    # not the string "None". A float would also diverge from R's
    # as.character() here -- str(3156.0) is "3156.0", not "3156" -- but
    # that's unreachable: target_sample_size is declared INTEGER (see
    # pipeline/alembic/versions/001_baseline_schema.py), so asyncpg always
    # hands back an int.
    size = out["Target Sample Size"]
    out["Target Sample Size"] = None if size is None else str(size)

    for column in _UNKNOWN_COLUMNS:
        out[column] = fill_missing_text(out[column], "(unknown)")

    if _COMPLETED_UNPUBLISHED.match(out["Estimated Completion Date"]):
        out["Estimated Completion Date"] = "Completed (unpublished)"

    out["Genetic Evidence"] = normalize_yes_no(out["Genetic Evidence"])
    return out
