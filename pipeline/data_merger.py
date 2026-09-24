"""Database merge logic for gene entries.

Handles merging new gene entries into PostgreSQL with batch operations.
"""

import logging
from collections.abc import Iterable, Mapping, Sequence
from typing import Any, Final, NotRequired, TypedDict

from pipeline.config import PipelineConfig
from pipeline.database import (
    get_existing_genes,
    merge_genes_transactional,
)
from pipeline.disease import load_disease
from pipeline.extraction_models import TRACKED_TRAITS, TRAIT_SYNONYMS, GeneEntry

logger = logging.getLogger(__name__)

# The curated dataset records some gene groups (a collagen heterotrimer
# pair, say) under one combined symbol, and NCBI has retired some symbols
# the curated table keeps the literature's name for. `geneAliases` in
# disease/pipeline.json is that correspondence, curated key to member
# symbols; this is the reverse map, member symbol to curated key. An
# extraction names whichever member its own paper discusses, so without this
# a run adds one pair member as a *new* gene beside the curated
# combined-symbol row -- genes.gene is UNIQUE, so nothing collapses them and
# the published table gains a duplicate. Observed on the first live run,
# which extracted one pair member from PMID 42437605.
#
# Canonicalisation is deliberately after NCBI validation, not before: both
# pair members are real symbols and must validate as themselves. Only the
# stored key is combined.
#
# C6orf195/LINC01600 is the same bug in a second form. The curated table
# keeps the symbol the literature uses, and the prompt asks for it by that
# name, but NCBI has retired it: uid 154386 is now LINC01600 with C6orf195
# among its aliases. Validation rewrites the extracted symbol to NCBI's
# current name, so the merge saw LINC01600, found no such curated gene, and
# would have inserted a 64th row beside C6orf195. The curated key wins here
# as it does for the collagen pair; tests/pipeline/test_data_merger.py reads
# data/gene_info.json so the next rename NCBI makes fails a test.
def reverse_aliases(aliases: Mapping[str, Iterable[str]]) -> dict[str, str]:
    """Each member of a curated key, upper-cased, mapped onto that key.

    Upper-cased because ``canonical_gene_symbol`` looks a symbol up
    upper-cased: HGNC writes some members in mixed case (``C9orf72``), and a
    member keyed as written could never be found, so its extractions became a
    row of their own beside the curated key. The key keeps its own spelling.
    """
    return {
        member.strip().upper(): curated
        for curated, members in aliases.items()
        for member in members
    }


_CANONICAL_GENE_SYMBOLS: Final[dict[str, str]] = reverse_aliases(
    load_disease().gene_aliases
)


def canonical_gene_symbol(symbol: str) -> str:
    """Map an extracted gene symbol onto the dataset's curated key.

    Unmapped symbols are returned unchanged, so this is a no-op for all but
    the one pair the curators combine.
    """
    return _CANONICAL_GENE_SYMBOLS.get(symbol.strip().upper(), symbol)


class HeldGene(TypedDict):
    """A new gene the insert floor refused, and the score it refused."""

    gene_symbol: str
    confidence: float


class MergeResult(TypedDict):
    """Result of merge operation.

    ``held_below_insert_floor`` is reported rather than only logged: a
    gene can clear the update floor, reach this merge and still be
    refused as a *new* row, and until it was returned here that loss was
    counted nowhere -- so the run's acceptance rate overstated by exactly
    the genes this list names.
    """

    inserted: int
    updated: int
    held_below_insert_floor: NotRequired[list[HeldGene]]


def dedupe_list[T](items: Iterable[T]) -> list[T]:
    """Remove duplicates from an iterable while preserving order.

    Args:
        items: Input values.

    Returns:
        New list with duplicates removed, maintaining first occurrence order.
    """
    return list(dict.fromkeys(items))


def format_omics(evidence: Sequence[str]) -> str:
    """Format omics evidence for database storage.

    Raw format uses '*' suffix and ';' separators.
    R/clean_table1.R strips the '*' and converts ';' to ', '.
    Supported omics types: TWAS, PWAS, EWAS

    Args:
        evidence: List of omics evidence strings.

    Returns:
        Formatted string for database storage.
    """
    return ";".join(f"{e}*" for e in evidence)


def deciding_entry(entries: Sequence[GeneEntry]) -> GeneEntry:
    """The entry a new row is admitted on: highest confidence, earliest wins.

    One gene can arrive from several papers in one batch, and the insert
    floor answers to the strongest evidence among them -- a gene the
    literature reports weakly once and firmly again is a gene, and gating
    on whichever paper came first would lose it.

    This is also the entry whose `confidence` and `source_quote` are
    published, and that pairing is the point. `merge_gene_entries` gated
    on `max(confidence)` while the row carried the *first* entry's pair,
    so a row admitted on 0.90 could be published at 0.50 -- below the 0.65
    insert floor `data/pipeline_run.json` names in the same run -- with
    the sentence that actually cleared the floor never published at all.
    `max` returns the first maximal element, so equal scores still fall to
    the earliest paper in the run's order.
    """
    return max(entries, key=lambda entry: entry.confidence)


def _build_combined_gene_data(entries: Sequence[GeneEntry]) -> dict[str, Any]:
    """Combine one or more entries for the same gene into a single DB row.

    When a batch contains multiple entries for the same gene (e.g. mentions
    in several papers), the per-field values are merged/deduped rather than
    overwriting one another.
    """
    first = entries[0]
    deciding = deciding_entry(entries)
    # The schema admits the prompt's own spellings of a tracked trait
    # (`cerebral-microbleeds` for CMB) so the model can obey the instruction
    # it was given; disease/vocabulary.json says what each folds onto. Exact
    # keys, not the export's substring rewrites: those are for curated
    # prose, and a substring fold has the NODDI/OD hazard. Before the
    # tracked filter, or the spelling would be dropped as untracked.
    gwas_traits = dedupe_list(
        TRAIT_SYNONYMS.get(trait, trait)
        for entry in entries
        for trait in entry.gwas_trait
    )
    # The schema admits the `untracked` vocabulary terms so the model can
    # name a phenotype the dashboard does not carry; this is where they are
    # disposed of. Like the sentinels, they are never stored: a trait in
    # gene_gwas_traits is a filter choice and a phenogram pill, and one with
    # neither fails tests/data_contract_test.ts on the next export. Logged
    # per gene so the signal the vocabulary exists to surface is still in
    # the run's log, and so a term the dashboard should carry can be found.
    untracked = [trait for trait in gwas_traits if trait not in TRACKED_TRAITS]
    if untracked:
        logger.info(
            f"  {first.gene_symbol}: dropped untracked GWAS trait(s) "
            f"{', '.join(untracked)}"
        )
    tracked_traits = [trait for trait in gwas_traits if trait in TRACKED_TRAITS]
    omics = dedupe_list(
        evidence for entry in entries for evidence in entry.omics_evidence
    )
    pmids = dedupe_list(entry.pmid for entry in entries if entry.pmid)
    protein_name = next(
        (entry.protein_name for entry in entries if entry.protein_name),
        first.gene_symbol,
    )

    return {
        "protein": protein_name,
        "gene": canonical_gene_symbol(first.gene_symbol),
        "chromosomal_location": "",
        "gwas_trait": tracked_traits,
        "mendelian_randomization": any(
            entry.mendelian_randomization for entry in entries
        ),
        "evidence_from_other_omics_studies": format_omics(omics),
        "brain_cell_types": "",
        "affected_pathway": "",
        "references": pmids,
        # The deciding entry's, not the first one's: this is the sentence
        # the insert floor was cleared on, so a reader who checks a new
        # row against the floor the run report names is reading the
        # evidence that admitted it. See `deciding_entry`.
        "source_quote": deciding.source_quote,
        # Kept beside its quote, from the same entry, so the published
        # confidence and the published sentence describe one extraction
        # rather than two different papers.
        "confidence": deciding.confidence,
    }


def _citation_only(gene_data: dict[str, Any]) -> dict[str, Any]:
    """The same row with every causal claim withheld.

    The permissive update floor is justified in `PipelineConfig` by the
    cheapness of *adding a reference* to a gene already in the table: that
    is reversible and visible in `git diff data/`. Three of the columns the
    UPDATE writes are neither. `mendelian_randomization` is OR-accumulated,
    so one sub-floor entry setting it True is a claim no later run can
    withdraw; `gwas_trait` and the omics list are append-only for the same
    reason (see `_append_gene_list_sql`). A 0.45 extraction was therefore
    asserting Mendelian randomization, a phenotype and an omics modality
    permanently, under a rationale that only ever covered the citation.

    So a paper between the two floors contributes what that rationale
    actually licenses -- its PMID, and the quote and confidence that
    describe its own evidence, which publish their own score for a reader
    to judge. The claims wait for the insert floor. Emptying the fields
    rather than branching in SQL is what keeps this true of both writes:
    the UPDATE reads `NULLIF($1,'')`, `COALESCE($2, FALSE)` and
    `string_to_array($3)`, and the list append is a no-op on `[]`.
    """
    return {
        **gene_data,
        "mendelian_randomization": False,
        "gwas_trait": [],
        "evidence_from_other_omics_studies": "",
    }


async def merge_gene_entries(
    new_entries: Sequence[GeneEntry],
    config: PipelineConfig | None = None,
) -> MergeResult:
    """Merge new gene entries into PostgreSQL using transactional batch operations.

    Database schema (matches R/clean_table1.R expectations):
    - protein, gene, chromosomal_location, gwas_trait,
    - mendelian_randomization, evidence_from_other_omics_studies,
    - link_to_monogenetic_disease, brain_cell_types,
    - affected_pathway, references, source_quote, confidence

    Args:
        new_entries: Sequence of validated GeneEntry instances.
        config: Supplies the insert floor; defaults to PipelineConfig().

    Returns:
        Dictionary with counts of inserted and updated entries.
    """
    if not new_entries:
        return {"inserted": 0, "updated": 0, "held_below_insert_floor": []}

    config = config or PipelineConfig()
    existing_genes = await get_existing_genes()

    # Collapse per-gene duplicates in the batch before splitting into
    # insert/update — otherwise the UPDATE would overwrite gwas_trait /
    # omics / protein from the first occurrence.
    grouped: dict[str, list[GeneEntry]] = {}
    for entry in new_entries:
        # Group on the curated key so a pair's two members in one batch
        # collapse into a single row rather than fighting over it.
        key = canonical_gene_symbol(entry.gene_symbol).upper()
        grouped.setdefault(key, []).append(entry)

    to_insert: list[dict[str, Any]] = []
    to_update: list[dict[str, Any]] = []
    below_insert_floor: list[HeldGene] = []
    claims_withheld: list[str] = []

    for gene_upper, entries_for_gene in grouped.items():
        gene_data = _build_combined_gene_data(entries_for_gene)
        # The score read here is the one `_build_combined_gene_data` put in
        # the row, because both go through `deciding_entry`. Computing the
        # maximum here independently is what let the gate and the published
        # number come from different papers.
        best = deciding_entry(entries_for_gene).confidence
        if gene_upper in existing_genes:
            # Below the insert floor the entry buys a citation, not a
            # claim -- see `_citation_only`.
            if best < config.confidence_threshold_insert:
                gene_data = _citation_only(gene_data)
                claims_withheld.append(gene_upper)
            to_update.append(gene_data)
            continue
        # A new row is a scientific claim in a published dataset, so it
        # answers to the stricter floor. The permissive floor upstream let
        # this entry through on purpose: it may still be a correct reference
        # for a gene that already exists, which is cheap and reversible.
        if best < config.confidence_threshold_insert:
            below_insert_floor.append({"gene_symbol": gene_upper, "confidence": best})
            continue
        to_insert.append(gene_data)

    if claims_withheld:
        logger.info(
            f"  {len(claims_withheld)} existing gene(s) updated with the "
            f"citation only, below the {config.confidence_threshold_insert} "
            f"floor for a claim: {', '.join(sorted(claims_withheld))}"
        )

    if below_insert_floor:
        held_symbols = ", ".join(
            sorted(entry["gene_symbol"] for entry in below_insert_floor)
        )
        logger.info(
            f"  {len(below_insert_floor)} new gene(s) held below the "
            f"{config.confidence_threshold_insert} insert floor: "
            f"{held_symbols}"
        )

    inserted, updated = await merge_genes_transactional(to_insert, to_update)

    logger.info(f"Merged genes: {inserted} inserted, {updated} updated")

    return {
        "inserted": inserted,
        "updated": updated,
        "held_below_insert_floor": below_insert_floor,
    }
