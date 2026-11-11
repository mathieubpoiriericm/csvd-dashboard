"""Durable record of submitted-but-uncollected batches, so a crash costs nothing.

`--batch` submits every paper to the Message Batches API and then polls for up
to 24 hours. The batch id lives only in memory and the run log, so a crash
inside that poll loop used to lose the whole paid submission, and a re-run paid
for it again. This file is written the moment a batch is accepted, and the
next run reads it to collect that batch instead of submitting a new one.

It holds a *list* of batches, not one: a re-run can reuse an old batch and
submit a fresh one for the remainder, and both have to survive a second crash.
Three properties matter:

- **Atomic.** `save` writes a temporary sibling, fsyncs it and `os.replace`s
  it over the file, so a crash leaves the old list or the new one and never a
  torn one. It replaces the whole list; the caller owns what it contains.
- **Fingerprinted.** A batch was extracted under one model, prompt and effort.
  Collecting it into a run configured differently would mix methods inside one
  dataset, so a fingerprint mismatch discards the file, as `checkpoint` does.
- **Never fatal to read.** A missing, corrupt or wrong-shaped file is an empty
  list and is deleted, so a stale file is not resumed by some later run whose
  settings happen to match it again. A file that cannot be deleted is still an
  empty list; `forget` holds to the same contract.

**A paid batch stays on record until each of its papers is merged or has no
usable result.** A run over one window must not erase a batch submitted for
another: `scripts.backfill_pubmed --batch` walks cumulative windows, so after
a crash in window k's poll the re-run starts at window 1, and a record of
window k that window 1 overwrote or cleared would be paid for twice. So the
collector writes back every recorded batch it did not find gone, beside a new
one, and the caller removes papers one by one with `forget` once they are
safely stored; only an emptied record is dropped.

There is no locking: one run writes it, once per submitted batch and once at
the end. Each batch records the sha256 of the document text sent per PMID, so
the collector can tell whether a paper's text has changed since the
submission.
"""

import json
import logging
import os
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_FINGERPRINT_KEY = "fingerprint"
_PENDING_KEY = "pending"


@dataclass(frozen=True)
class PendingBatch:
    """One submitted batch and what it was sent."""

    batch_id: str
    # PMID -> sha256 hex of the document text sent for that paper.
    document_sha256: dict[str, str]


def save(
    path: str, run_fingerprint: dict[str, Any], pending: list[PendingBatch]
) -> None:
    """Replace the file with *pending*, atomically and durably."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        _FINGERPRINT_KEY: run_fingerprint,
        _PENDING_KEY: [
            {"batch_id": p.batch_id, "document_sha256": p.document_sha256}
            for p in pending
        ],
    }
    replacement = target.with_name(target.name + ".tmp")
    with replacement.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle)
        handle.flush()
        # The point of the file is to survive a process that stops existing.
        os.fsync(handle.fileno())
    os.replace(replacement, target)


def load(path: str, run_fingerprint: dict[str, Any]) -> list[PendingBatch]:
    """The batches saved by a run configured like this one, oldest first.

    Returns an empty list, and deletes the file, when there is nothing usable:
    no file, an unreadable or wrong-shaped one, or a different fingerprint.
    """
    target = Path(path)
    if not target.exists():
        return []
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        logger.warning("Discarding an unreadable pending-batch file", exc_info=True)
        _discard(target)
        return []

    pending = _parse(raw, run_fingerprint)
    if pending is None:
        # Named, because their papers are about to be paid for again and an
        # operator who wants the old results can still fetch them by id.
        logger.warning(
            "Discarding a pending-batch file written by a different run "
            "configuration or in an unknown shape (batches: %s); its papers "
            "will be submitted again.",
            ", ".join(_batch_ids(raw)) or "none readable",
        )
        _discard(target)
        return []
    return pending


def _discard(target: Path) -> None:
    """Delete a file `load` will not use, or say why it could not."""
    try:
        target.unlink(missing_ok=True)
    except OSError:
        logger.warning("Could not delete %s", target, exc_info=True)


def _batch_ids(raw: Any) -> list[str]:
    """Whatever batch ids a file names, however wrong the rest of it is."""
    entries = raw.get(_PENDING_KEY) if isinstance(raw, dict) else None
    if not isinstance(entries, list):
        return []
    return [
        entry["batch_id"]
        for entry in entries
        if isinstance(entry, dict) and isinstance(entry.get("batch_id"), str)
    ]


def _parse(raw: Any, run_fingerprint: dict[str, Any]) -> list[PendingBatch] | None:
    """The batches in a decoded file, or None if it is not one of ours."""
    if not isinstance(raw, dict) or raw.get(_FINGERPRINT_KEY) != run_fingerprint:
        return None
    entries = raw.get(_PENDING_KEY)
    if not isinstance(entries, list):
        return None
    batches = []
    for entry in entries:
        if not isinstance(entry, dict):
            return None
        batch_id = entry.get("batch_id")
        hashes = entry.get("document_sha256")
        if not isinstance(batch_id, str) or not isinstance(hashes, dict):
            return None
        if not all(
            isinstance(k, str) and isinstance(v, str) for k, v in hashes.items()
        ):
            return None
        batches.append(PendingBatch(batch_id=batch_id, document_sha256=hashes))
    return batches


def forget(path: str, run_fingerprint: dict[str, Any], pmids: Iterable[str]) -> None:
    """Take *pmids* off every record, once their results are safely stored.

    A record left with no paper is dropped, and the file goes with the last
    one. Records holding none of *pmids* are written back untouched: they
    belong to some other window's run and are still paid for. Never raises,
    as `load` does not: the papers are already checkpointed, so a record that
    cannot be rewritten costs at most a later run replaying them.
    """
    done = set(pmids)
    pending = load(path, run_fingerprint)
    if not pending:
        return
    remaining = [
        PendingBatch(
            batch_id=batch.batch_id,
            document_sha256={
                pmid: digest
                for pmid, digest in batch.document_sha256.items()
                if pmid not in done
            },
        )
        for batch in pending
    ]
    remaining = [batch for batch in remaining if batch.document_sha256]
    if remaining == pending:
        return
    try:
        if remaining:
            save(path, run_fingerprint, remaining)
        else:
            Path(path).unlink(missing_ok=True)
    except OSError:
        logger.warning(
            "Could not update the pending-batch file %s; a later run may "
            "collect papers this one already stored",
            path,
            exc_info=True,
        )
