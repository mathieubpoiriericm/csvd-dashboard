---
paths:
  - "pipeline/main.py"
  - "pipeline/checkpoint.py"
  - "pipeline/config.py"
  - "scripts/backfill_pubmed.py"
  - "tests/pipeline/test_checkpoint.py"
  - "tests/pipeline/test_config.py"
  - "tests/scripts/test_backfill_pubmed.py"
  - "tests/pipeline/test_main.py"
  - "tests/pipeline/test_main_orchestration.py"
---

# Long windows

The window's measured cost, the Opus 4.8 fallback's per-paper premium, the
credit-balance check, the resume semantics, the `--batch` exception and the
checkpoint's own invariants (the fingerprint, the `flock`, the request-order
merge) are in the `run-long-window` skill
(`.claude/skills/run-long-window/SKILL.md`); the `--batch` warning is also in
"Commands" in the root `CLAUDE.md`.

`scripts/backfill_pubmed.py` is the other half, optional rather than the
default: cumulative chunks committed as each finishes, at the cost of narrowing
`_run_batch_validation` from the year to one chunk, which is why the checkpoint
and not chunking is the answer to a crash. Its module docstring and the
`run-long-window` skill carry the command and the trade.

**Both preview flags deduplicate.** They used to skip it, which made the preview
wrong in both directions: `--test-mode` reported every paper in the window as
new, and `--dry-run` -- documented as "skip database writes" -- re-extracted
papers already in `pubmed_refs` at full price, so the cheap rehearsal cost
exactly what the real run costs. Reading `pubmed_refs` is not a write. A preview
still has to work with no database at all, so `_PREVIEW_DB_FAILURES` is
tolerated there and re-raised on a live run, where swallowing it would silently
reprocess the whole window. "No database at all" includes no `DB_*` variables --
a fresh clone, or CI -- which raises `DatabaseConfigError` before any socket is
opened, so it is in the tuple beside `OSError` and `PostgresError`.
`--test-mode` is the free way to count what a window would actually process
before paying for it.

**`estimated_tokens_per_call` is a reservation, not a measurement**, and it is
the throughput ceiling: raise it and `tpm_limit` together, or neither. The field
comment in `config.py` records the measurement behind the figure, and
`tests/pipeline/test_config.py` pins the product against the limit.
