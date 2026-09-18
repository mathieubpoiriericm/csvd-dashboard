"""The row contract every annotation client emits.

One shape covers all three sources because they produce the same kind of fact:
a gene, a relation, an object with a canonical identifier, and provenance.
``pipeline.database`` consumes exactly these dataclasses, so a client never
writes SQL and the database layer never learns an API's envelope.
"""

import logging
from collections.abc import Collection
from dataclasses import dataclass
from typing import Final

from pipeline.disease import load_disease

logger = logging.getLogger(__name__)

# Curated keys that are not gene symbols, and the symbols to look them up by.
# Read from `geneAliases` in disease/pipeline.json -- a stdlib-only import,
# so this module's promise to import nothing from the rest of the pipeline
# still holds in spirit.
#
# Two of the 63 curated rows name something no external database carries.
# One alias key is a curator label for a two-gene pair -- the pair's members
# form one heterotrimer and the literature reports them together -- and
# `C6orf195` is a symbol NCBI has retired in favour of `LINC01600`.
# Queried literally, both return nothing from ClinVar, Orphadata and Open
# Targets alike, and a zero-count status row is written; the dashboard then
# shows no disease at all for the pair that causes Gould syndrome, PADMAL,
# HANAC and brain small-vessel disease 1 and 2. A blank there does not read
# as "this key is not a symbol", it reads as "no disease is known".
#
# So a lookup fans out to the real symbols and the rows come back filed under
# the curated key, which is the key `genes.gene` holds and therefore the key
# the export asks for. This is the same correspondence
# `data_merger._CANONICAL_GENE_SYMBOLS` applies in the other direction when a
# run extracts one of the pair's own member symbols;
# `tests/pipeline/test_annotations.py` reconciles the two so neither can gain
# an entry the other lacks.
#
# What it costs: `gene_annotations` has no column naming which member gene
# supplied a row, so a disease from each member gene is published side by
# side under the shared alias key with nothing saying which chain carries
# which. Every row still carries its own OMIM, MONDO and Orphanet
# identifiers, so no identifier is transferred between diseases -- the loss
# is the attribution within the pair, and the curated key already asserts
# the pair is one entity. Recording the member gene means a migration, and
# is the upgrade if the distinction is ever wanted.
_LOOKUP_ALIASES: Final[dict[str, tuple[str, ...]]] = dict(load_disease().gene_aliases)


def lookup_symbols(curated_symbol: str) -> tuple[str, ...]:
    """The symbols an external database is asked for on this row's behalf.

    A curated key that is already a gene symbol -- 61 of the 63 -- is
    returned unchanged, so every caller can fan out unconditionally.
    """
    return _LOOKUP_ALIASES.get(curated_symbol, (curated_symbol,))


def expand_lookup_symbols(
    curated_symbols: list[str],
) -> tuple[list[str], dict[str, str]]:
    """Split a curated list into the symbols to query and how to file them.

    Returns the query symbols in curated order, and the map back from each
    to the curated key its rows are stored under. The map is what keeps a
    fanned-out row joinable: `genes.gene` holds the curated alias key, so a
    row filed under one member symbol would reach the export and match
    nothing.
    """
    queries: list[str] = []
    curated_by_query: dict[str, str] = {}
    for curated in curated_symbols:
        for symbol in lookup_symbols(curated):
            if symbol not in curated_by_query:
                queries.append(symbol)
                curated_by_query[symbol] = curated
    return queries, curated_by_query


# Which authority names a disease group, best first. MONDO is the integrating
# ontology and is preferred wherever it exists; MedGen is last because ClinVar
# emits a MedGen id even for its placeholder traits.
_GROUP_KEY_PREFERENCE: Final[tuple[str, ...]] = (
    "MONDO",
    "OMIM",
    "Orphanet",
    "MedGen",
)


def group_key_for(xrefs: Collection[str]) -> str:
    """Pick the canonical identifier that names this disease group.

    Returns ``""`` for a set naming no disease authority -- a GO term or an
    Ensembl accession -- because those rows group with nothing. The empty
    string rather than ``None``: PostgreSQL treats NULL as distinct from
    itself in a UNIQUE constraint, so NULL would let duplicates insert.

    Where the winning authority names the trait more than once the choice is
    ``min`` -- string order, which is arbitrary but total, and a total order
    is the property that matters: the key has to come out the same for every
    row of a trait or the disease splits into two published rows. String
    order is not a claim that the smaller identifier is the better one, so
    the ambiguity is logged rather than resolved silently; a trait whose
    authority genuinely disagrees with itself is worth a look.
    """
    for prefix in _GROUP_KEY_PREFERENCE:
        candidates = sorted(
            xref for xref in xrefs if xref.startswith(f"{prefix}:")
        )
        if candidates:
            if len(candidates) > 1:
                logger.debug(
                    "Trait carries %d %s identifiers (%s); grouping on %s",
                    len(candidates),
                    prefix,
                    ", ".join(candidates),
                    candidates[0],
                )
            return candidates[0]
    return ""


@dataclass(slots=True)
class AnnotationRow:
    """One gene -> object edge, with its provenance."""

    gene_symbol: str
    source: str
    relation: str
    group_key: str
    object_id: str
    object_label: str | None
    qualifier: str | None
    score: float | None
    evidence_count: int | None
    source_version: str | None

    @staticmethod
    def sort_key(row: AnnotationRow) -> tuple[str, ...]:
        """Total order over the UNIQUE key, so writes are reproducible."""
        return (
            row.gene_symbol,
            row.source,
            row.relation,
            row.group_key,
            row.object_id,
        )


@dataclass(slots=True)
class AnnotationStatus:
    """That a gene was fetched from a source, and how many rows it yielded.

    Written even when ``row_count`` is 0 -- that is the negative cache, and
    without it a gene with no annotations looks like a gene never fetched.
    """

    gene_symbol: str
    source: str
    row_count: int
    source_version: str | None


@dataclass(slots=True)
class DrugAnnotationRow:
    """One trial drug's mechanism of action, as Open Targets reports it.

    ``resolved`` is False when the drug name matched nothing, which is a real
    and expected outcome -- 5 of the 11 drugs in ``data/table2.json`` are
    unregistered agents or trade-named combinations ChEMBL does not carry.
    """

    drug: str
    chembl_id: str | None
    action_type: str | None
    mechanism_of_action: str | None
    target_symbols: str | None
    source_version: str | None
    resolved: bool
