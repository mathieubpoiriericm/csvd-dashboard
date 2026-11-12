"""Durable record of submitted-but-uncollected batches, so a crash costs nothing.

`--batch` submits every paper to the Message Batches API and then polls for up
to 24 hours. Before this file the batch id lived only in memory and the run
log, so a crash inside that poll loop lost the whole paid submission, and a
re-run paid for it again. This file is written the moment a batch is accepted, and the
next run reads it to collect that batch instead of submitting a new one.

It holds a *list* of batches, not one: a re-run can reuse an old batch and
submit a fresh one for the remainder, and both have to survive a second crash.
Four properties matter:

- **Atomic.** `save` writes a temporary sibling, fsyncs it and `os.replace`s
  it over the file, so a crash leaves the old list or the new one and never a
  torn one. It replaces the whole list; the caller owns what it contains.
- **Fingerprinted.** A batch was extracted under one model, prompt and effort.
  Collecting it into a run configured differently would mix methods inside one
  dataset, so a fingerprint mismatch discards the file, as `checkpoint` does.
- **Pruned by age.** The API keeps a batch's results for 29 days, so `load`
  drops a batch whose `submitted_at` is older than that plus a day's margin
  and rewrites the file without it: a record for a window that is never
  re-run would otherwise stay for ever, since nothing looks it up to find it
  expired. A record with no `submitted_at` (written before the field) is
  kept, and written back as it was.
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
import time
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_FINGERPRINT_KEY = "fingerprint"
_PENDING_KEY = "pending"

# The Message Batches API keeps a batch's results for 29 days after it was
# created, and then answers for it as for an id it never knew. A record older
# than that can only be found gone, and nothing looks up a record for a
# window that is never re-run, so `load` drops it on age instead.
RESULTS_RETENTION_SECONDS = 29 * 24 * 60 * 60

# Slack on top of the retention before a record is pruned. `submitted_at` is
# the API's clock and the cutoff is this machine's, so a local clock running
# ahead could otherwise drop a batch minutes before the API expires it. A late
# prune costs nothing: the collector already drops a batch the API reports
# gone.
PRUNE_MARGIN_SECONDS = 24 * 60 * 60


@dataclass(frozen=True)
class PendingBatch:
    """One submitted batch and what it was sent."""

    batch_id: str
    # PMID -> sha256 hex of the document text sent for that paper.
    document_sha256: dict[str, str]
    # When the API created the batch, in seconds since the epoch. None for a
    # record written before this field existed: its age is unknown, so it is
    # kept, and the collector already drops a batch the API reports gone.
    submitted_at: float | None = None


def save(
    path: str, run_fingerprint: dict[str, Any], pending: list[PendingBatch]
) -> None:
    """Replace the file with *pending*, atomically and durably."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        _FINGERPRINT_KEY: run_fingerprint,
        _PENDING_KEY: [
            {
                "batch_id": p.batch_id,
                "document_sha256": p.document_sha256,
                "submitted_at": p.submitted_at,
            }
            for p in pending
        ],
    }
    replacement = target.with_name(target.name + ".tmp")
    try:
        with replacement.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle)
            handle.flush()
            # The point of the file is to survive a process that stops
            # existing.
            os.fsync(handle.fileno())
        os.replace(replacement, target)
    except BaseException:
        # A failed write must not leave its temporary sibling behind; the
        # original error is the one the caller sees.
        try:
            replacement.unlink(missing_ok=True)
        except OSError:
            logger.warning("Could not delete %s", replacement, exc_info=True)
        raise


def load(
    path: str, run_fingerprint: dict[str, Any], *, now: float | None = None
) -> list[PendingBatch]:
    """The batches saved by a run configured like this one, oldest first.

    Returns an empty list, and deletes the file, when there is nothing usable:
    no file, an unreadable or wrong-shaped one, or a different fingerprint.

    A batch created more than `RESULTS_RETENTION_SECONDS` plus
    `PRUNE_MARGIN_SECONDS` before *now* (the clock, injectable for tests) is
    left out, logged by id, and the file is rewritten without it, or deleted
    when it was the last: its results are gone from the API. A batch with no
    `submitted_at` is kept.
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
    return _prune_expired(target, run_fingerprint, pending, now)


def _prune_expired(
    target: Path,
    run_fingerprint: dict[str, Any],
    pending: list[PendingBatch],
    now: float | None,
) -> list[PendingBatch]:
    """*pending* without the batches the API no longer holds, and the file too.

    Best-effort: a file that cannot be rewritten still loads without them, and
    the next load drops them again.
    """
    cutoff = (
        (time.time() if now is None else now)
        - RESULTS_RETENTION_SECONDS
        - PRUNE_MARGIN_SECONDS
    )
    kept = [p for p in pending if p.submitted_at is None or p.submitted_at >= cutoff]
    if len(kept) == len(pending):
        return pending
    for batch in pending:
        if batch not in kept:
            logger.info(
                "Dropping recorded batch %s: it is older than the API keeps "
                "results, so its papers will be submitted again.",
                batch.batch_id,
            )
    try:
        if kept:
            save(str(target), run_fingerprint, kept)
        else:
            target.unlink(missing_ok=True)
    except OSError:
        logger.warning("Could not drop expired batches from %s", target, exc_info=True)
    return kept


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
        submitted_at = entry.get("submitted_at")
        if not isinstance(batch_id, str) or not isinstance(hashes, dict):
            return None
        if submitted_at is not None and (
            isinstance(submitted_at, bool) or not isinstance(submitted_at, int | float)
        ):
            return None
        if not all(
            isinstance(k, str) and isinstance(v, str) for k, v in hashes.items()
        ):
            return None
        batches.append(
            PendingBatch(
                batch_id=batch_id,
                document_sha256=hashes,
                submitted_at=None if submitted_at is None else float(submitted_at),
            )
        )
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
            submitted_at=batch.submitted_at,
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
