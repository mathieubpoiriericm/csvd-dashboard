"""Diff the curated rows against a preview run's rows into a review round.

A round is what the review committee reads: one *change* per row the run
would alter, each carrying the fields that differ and the findings that
explain it. `build_review_round` is pure; `read_review_round` reads the
two databases that feed it, and the preview export writes the file.
"""

import hashlib
import json
import logging
from collections.abc import Mapping, Sequence
from typing import Any, Final

from pipeline.data_merger import canonical_gene_symbol
from pipeline.database import Database
from pipeline.preview_run import gold_connection
from pipeline.steps import PREVIEW_RUN_MODE

logger = logging.getLogger(__name__)

ROUND_FILE: Final = "review_round.json"

# A change to one of these keys alters what the dataset claims; any other
# difference is a change of citation only.
_CLAIM_FIELDS: Final[frozenset[str]] = frozenset(
    {"gwasTrait", "mendelianRandomization", "evidenceFromOtherOmicsStudies"}
)

# Placeholders the gene table holds for "nothing yet": never a value gained
# or lost.
_SENTINELS: Final[frozenset[str]] = frozenset(
    {
        "(none found)",
        "(reference needed)",
        "(unknown)",
        "(none)",
        "(not yet extracted)",
    }
)

# A finding's keys, in the run report's own order (`GeneRecord`); `_finding`
# appends the ledger's `fulltext` and `extractionModel` after them.
_FINDING_KEYS: Final[tuple[str, ...]] = (
    "pmid",
    "confidence",
    "gwasTraits",
    "proteinName",
    "mendelianRandomization",
    "omicsEvidence",
    "causalEvidenceSummary",
    "sourceQuote",
    "citationOnly",
)


class ReviewRoundError(ValueError):
    """The two row sets cannot be diffed into a round."""


def _key(gene: object) -> str:
    return str(gene).strip().upper()


def _digest(value: object) -> str:
    """The first 16 hex digits of the SHA-256 of *value*'s canonical JSON."""
    text = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _gained(before: Sequence[Any], after: Sequence[Any]) -> list[Any]:
    return [v for v in after if v not in before and v not in _SENTINELS]


def _field(name: str, before: Any, after: Any) -> dict[str, Any]:
    listed = isinstance(before, list) and isinstance(after, list)
    return {
        "field": name,
        "before": before,
        "after": after,
        "added": _gained(before, after) if listed else [],
        "removed": _gained(after, before) if listed else [],
    }


def _differing_fields(
    before: Mapping[str, Any], after: Mapping[str, Any]
) -> list[dict[str, Any]]:
    """One entry per differing key, in the row's key order."""
    keys = [*after, *(k for k in before if k not in after)]
    return [
        _field(k, before.get(k), after.get(k))
        for k in keys
        if before.get(k) != after.get(k)
    ]


def _finding(
    raw: Mapping[str, Any], papers: Mapping[str, Mapping[str, Any]]
) -> dict[str, Any]:
    paper = papers.get(raw["pmid"], {})
    return {
        **{key: raw[key] for key in _FINDING_KEYS},
        "fulltext": paper.get("fulltext"),
        "extractionModel": paper.get("extractionModel"),
    }


def _kind(fields: Sequence[Mapping[str, Any]]) -> str:
    """`claims` when a claim field differs; otherwise `citation_protein` when
    the protein does, which a run can no longer replace but once did; else
    `citation`."""
    changed = {f["field"] for f in fields}
    if changed & _CLAIM_FIELDS:
        return "claims"
    if "protein" in changed:
        return "citation_protein"
    return "citation"


def build_review_round(
    *,
    gold_rows: Sequence[Mapping[str, Any]],
    preview_rows: Sequence[Mapping[str, Any]],
    findings: Sequence[Mapping[str, Any]],
    papers: Mapping[str, Mapping[str, Any]],
    run_timestamp: str,
) -> dict[str, Any]:
    """The round a preview run proposes against the gold rows.

    Raises ReviewRoundError when a gold gene is missing from the preview
    rows (a run never deletes a row), when a field of a change lost a list
    value (a run never removes one, so gold was curated after the preview
    was copied from it, on a row the run also touched), or when a change has
    no finding to explain it.
    """
    gold = {_key(row["gene"]): row for row in gold_rows}
    preview_keys = {_key(row["gene"]) for row in preview_rows}
    for key, row in gold.items():
        if key not in preview_keys:
            raise ReviewRoundError(
                f"gold gene {row['gene']} is missing from the preview"
            )

    changes: list[dict[str, Any]] = []
    for after in preview_rows:
        before = gold.get(_key(after["gene"]))
        if before is None:
            kind, fields = "new", []
        else:
            fields = _differing_fields(before, after)
            if not fields:
                continue
            for field in fields:
                if field["removed"]:
                    raise ReviewRoundError(
                        f"the preview's {after['gene']} lacks {field['removed']}"
                        f" of gold's {field['field']}: a run never removes a list"
                        " value, so gold changed after the preview was copied"
                    )
            kind = _kind(fields)
        changes.append(
            {
                "gene": after["gene"],
                "kind": kind,
                "version": _digest([before, after]),
                "before": before,
                "after": after,
                "fields": fields,
                "findings": [],
            }
        )

    by_gene = {_key(change["gene"]): change for change in changes}
    dropped = 0
    for raw in findings:
        change = by_gene.get(_key(canonical_gene_symbol(raw["symbol"])))
        if change is None:
            dropped += 1
        else:
            change["findings"].append(_finding(raw, papers))
    if dropped:
        logger.info("Dropped %d finding(s) for rows the run left unchanged", dropped)

    for change in changes:
        if not change["findings"]:
            raise ReviewRoundError(
                f"no finding explains the change to {change['gene']}"
            )

    return {
        "id": f"round-{run_timestamp}",
        "state": "open",
        "runTimestamp": run_timestamp,
        "base": _digest(list(gold_rows)),
        "changes": changes,
    }


# Ordered, like every export query: the ledger becomes a mapping here, but
# a reader that iterated it would otherwise see the server's physical order.
_PAPERS_SQL: Final = (
    "SELECT pmid, fulltext_available, extraction_model FROM pubmed_refs"
    " WHERE pmid = ANY($1) ORDER BY pmid"
)


async def read_review_round(run: Mapping[str, Any]) -> dict[str, Any]:
    """The round the preview database proposes against the gold database.

    ``run`` is the preview report the export publishes beside the round;
    its accepted genes are the findings. The process must already have
    entered the preview database: the shared pool reads the preview rows
    and the papers' ledger, and `gold_connection` -- read-only, closed on
    the way out -- reads the gold rows. Nothing here catches a database
    error. The readers that tolerate migration lag do so because a missing
    table means "nothing yet"; a preview run cannot have run on a database
    without these tables, so here a missing one is a broken database and
    the export fails rather than publishing a partial round.

    Raises:
        ReviewRoundError: Before gold is read, when the preview database
            holds other than one preview run (the report could not say
            which rows are its own), or when the report capped its
            accepted genes (a finding left out would leave a change
            unexplained); and whenever `build_review_round` refuses.
    """
    # Imported here: pipeline.export.main imports this module for the
    # preview export, and read_published_genes is its reader.
    from pipeline.export.main import read_published_genes

    async with Database.connection() as conn:
        runs = await conn.fetchval(
            "SELECT count(*) FROM pipeline_runs WHERE run_mode = $1",
            PREVIEW_RUN_MODE,
        )
    if runs != 1:
        raise ReviewRoundError(
            f"the preview database holds {runs} preview runs; a round is"
            " built from exactly one, so recreate the preview database from"
            " production as the regenerate-data skill's \"The preview database\""
            " section says, and run the preview again"
        )
    accepted = run["acceptedGenes"]
    if accepted["total"] > accepted["shown"]:
        raise ReviewRoundError(
            f"the run report lists {accepted['shown']} of {accepted['total']}"
            " accepted genes, and a round needs every finding"
        )
    findings: list[Mapping[str, Any]] = accepted["items"]

    preview_rows = await read_published_genes()
    async with gold_connection() as gold:
        gold_rows = await read_published_genes(gold)

    pmids = sorted({f["pmid"] for f in findings if f.get("pmid")})
    async with Database.connection() as conn:
        ledger = await conn.fetch(_PAPERS_SQL, pmids)
    papers = {
        row["pmid"]: {
            "fulltext": row["fulltext_available"],
            "extractionModel": row["extraction_model"],
        }
        for row in ledger
    }

    return build_review_round(
        gold_rows=gold_rows,
        preview_rows=preview_rows,
        findings=findings,
        papers=papers,
        run_timestamp=run["runTimestamp"],
    )
