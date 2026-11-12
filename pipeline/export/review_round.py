"""Diff the curated rows against a preview run's rows into a review round.

A round is what the review committee reads: one *change* per row the run
would alter, each carrying the fields that differ and the findings that
explain it. This module is pure -- reading the databases and writing the
file belong to its callers.
"""

import hashlib
import json
import logging
from collections.abc import Mapping, Sequence
from typing import Any, Final

from pipeline.data_merger import canonical_gene_symbol

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

_FINDING_KEYS: Final[tuple[str, ...]] = (
    "pmid",
    "confidence",
    "gwasTraits",
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
    rows (a run never deletes a row) or when a change has no finding to
    explain it.
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
            kind = (
                "claims"
                if any(f["field"] in _CLAIM_FIELDS for f in fields)
                else "citation"
            )
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
