"""Durable record of papers already extracted, so a crash costs nothing.

`_merge_processed_batch` is step 5 of 6: genes reach the database and
`record_processed_pmids_batch` writes the PMIDs only once every paper in the
window has been extracted. Until then the run holds hours of paid extraction
in memory and nothing durable. A year's window is ~795 papers, ~3 hours and
~$70, and a crash at hour two used to discard all of it.

The file is JSON Lines: a header carrying the extraction fingerprint, then one
record per completed paper, appended as it completes. Four properties matter:

- **Append-only.** A record is one `write` of one line, so a process killed
  mid-append can corrupt only the final line, and `load` drops it. Rewriting
  the whole file per paper could instead lose every earlier one.
- **Fingerprinted.** A checkpoint is only reusable by a run extracting the
  same way. Restoring a paper the previous run extracted under a different
  model, prompt or effort would mix methods inside one dataset -- which is
  what pinning EXTRACTION_MODEL in code exists to prevent -- so a mismatch
  discards the file rather than resuming from it.
- **Keyed by PMID, not by window.** `--days-back` is not part of the
  fingerprint, so a checkpoint written by a 30-day run is valid for the 60-day
  run that resumes it. That is what lets `scripts/backfill_pubmed.py` make
  progress across chunks.
- **Locked.** Every run shares one path, and a scheduled nightly run can fire
  over a long re-run. `append`, `load`, `clear` and `remove` each hold an
  exclusive `flock` on a sibling `.lock` file for the whole of their work, so
  a prune cannot rewrite the file from a snapshot taken before the other run's
  last paper -- which silently discarded extraction already paid for.

Records are plain dicts here. The mapping to and from `PaperResult` lives in
`pipeline/main.py`, which owns that type; this module owns the file.
"""

import fcntl
import json
import logging
import os
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from pipeline.config import PipelineConfig

logger = logging.getLogger(__name__)

_HEADER_KEY = "fingerprint"


def fingerprint(config: PipelineConfig) -> dict[str, Any]:
    """What a checkpoint has to agree with to be reusable.

    Everything here changes what extraction returns for the same paper: the
    model and its thinking mode, the prompt, the effort, the two confidence
    floors, which decide per paper which genes are validated and which are
    rejected, the verbatim-quote gate, which drops genes inside extraction
    before validation ever sees them, and the truncation limit, which decides
    how much of the paper the model -- and the quote check -- was given. The
    search window deliberately is not here.
    """
    return {
        "model": config.llm_model,
        "model_version": config.model_version,
        "thinking_mode": config.thinking_mode,
        "effort": config.llm_effort,
        "prompt_version": config.prompt_version,
        "confidence_threshold_update": config.confidence_threshold_update,
        "confidence_threshold_insert": config.confidence_threshold_insert,
        "require_verified_quotes": config.require_verified_quotes,
        "max_paper_text_chars": config.max_paper_text_chars,
    }


@contextmanager
def _locked(target: Path) -> Generator[None]:
    """Hold the checkpoint exclusively for one whole read-modify-write.

    Every run uses the same path, and `pipeline/main.py` already anticipates
    "a scheduler firing over a manual re-run". `remove` reads the file,
    filters it and replaces it from that snapshot; without a lock the records
    the other run appended in between are rewritten away, and the extraction
    they stand for was paid for.

    The lock is a sibling `.lock` file rather than the checkpoint itself,
    because `remove` unlinks and replaces the checkpoint: a lock held on an
    inode that is no longer the file at that path guards nothing. It is
    created and never removed, and it is where the parent directory is made,
    so every entry point below can assume it exists.
    """
    lock_path = target.with_name(target.name + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a", encoding="utf-8") as handle:
        # Closing the handle releases the lock, on the error path too.
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        yield


def append(path: str, run_fingerprint: dict[str, Any], record: dict[str, Any]) -> None:
    """Add one completed paper, writing the header first if the file is new."""
    target = Path(path)
    with _locked(target):
        new_file = not target.exists() or target.stat().st_size == 0
        with target.open("a", encoding="utf-8") as handle:
            if new_file:
                handle.write(json.dumps({_HEADER_KEY: run_fingerprint}) + "\n")
            handle.write(json.dumps(record) + "\n")
            # The point of the file is to survive a process that stops
            # existing, so a record is not "written" while it sits in a
            # buffer.
            handle.flush()
            os.fsync(handle.fileno())


def load(path: str, run_fingerprint: dict[str, Any]) -> list[dict[str, Any]]:
    """Every complete record in a checkpoint written the same way as this run.

    Returns an empty list, and deletes the file, when there is nothing usable:
    no file, an unreadable header, or a fingerprint from a different method.
    Deleting rather than ignoring keeps a stale file from being silently
    resumed by some later run whose settings happen to match it again.
    """
    target = Path(path)
    if not target.exists():
        return []

    try:
        with _locked(target):
            return _read(target, run_fingerprint)
    except OSError:
        logger.warning("Could not read the extraction checkpoint", exc_info=True)
        return []


def _read(target: Path, run_fingerprint: dict[str, Any]) -> list[dict[str, Any]]:
    """`load`'s work, with the lock already held."""
    lines = target.read_text(encoding="utf-8").splitlines()

    header = _parse(lines[0]) if lines else None
    if header is None or header.get(_HEADER_KEY) != run_fingerprint:
        logger.warning(
            "Discarding an extraction checkpoint written by a different run "
            "configuration; its papers will be extracted again."
        )
        # Not `clear`, which takes the lock this call already holds.
        target.unlink(missing_ok=True)
        return []

    records = []
    for line in lines[1:]:
        record = _parse(line)
        if record is None:
            # Only the last line can be half-written, and it is the only one
            # worth losing: the process died in the middle of writing it.
            logger.warning("Dropping an incomplete checkpoint record")
            continue
        records.append(record)
    return records


def clear(path: str) -> None:
    """Remove the checkpoint outright -- for a file this run cannot use."""
    target = Path(path)
    with _locked(target):
        target.unlink(missing_ok=True)


def remove(path: str, pmids: set[str]) -> None:
    """Drop the records for *pmids*, once those papers are in `pubmed_refs`.

    The rest stay. A checkpoint written by a wider window holds papers this
    run did not publish, and they were paid for: deleting the whole file
    after the merge, as it used to be, let a nightly 7-day run destroy a
    crashed year-long run's extraction for every paper outside its own
    window. The file is unlinked only when no record remains, and rewritten
    atomically otherwise, so a crash mid-prune leaves the old file or the
    new one and never a torn one.

    A record's PMID is read at `result.pmid` -- the one fact about a
    record's shape this module knows. A record without one can never be
    merged, so it can never be removed by name; it is dropped here rather
    than kept forever.

    The prune is best effort, like the append. It runs after
    `_merge_processed_batch` has committed the genes and the PMIDs, so a
    full disk or a read-only `logs/` here must not turn a run whose data
    reached the database into a recorded failure. The records left behind
    are harmless: their PMIDs are in `pubmed_refs`, and the next run filters
    them out before extraction.
    """
    target = Path(path)
    if not target.exists():
        return
    try:
        with _locked(target):
            _prune(target, pmids)
    except OSError:
        logger.warning(
            "Could not prune the extraction checkpoint; its merged records "
            "stay, and the next run skips those PMIDs anyway",
            exc_info=True,
        )


def _prune(target: Path, pmids: set[str]) -> None:
    """`remove`'s work, with the lock already held."""
    lines = target.read_text(encoding="utf-8").splitlines()

    kept: list[str] = []
    for line in lines[1:]:
        pmid = _record_pmid(_parse(line))
        if pmid is not None and pmid not in pmids:
            kept.append(line)
    if not kept:
        target.unlink(missing_ok=True)
        return

    replacement = target.with_name(target.name + ".tmp")
    with replacement.open("w", encoding="utf-8") as handle:
        handle.write("\n".join([lines[0], *kept]) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(replacement, target)


def _record_pmid(record: dict[str, Any] | None) -> str | None:
    """The PMID a record is about, or None if it does not say."""
    if record is None:
        return None
    result = record.get("result")
    if not isinstance(result, dict):
        return None
    pmid = result.get("pmid")
    return pmid if isinstance(pmid, str) else None


def _parse(line: str) -> dict[str, Any] | None:
    """One JSON object per line, or None if this one did not finish."""
    try:
        parsed = json.loads(line)
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None
