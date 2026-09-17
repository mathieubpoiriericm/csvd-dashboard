# Extraction Transparency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every extracted claim in the dashboard traceable to the sentence
that produced it, and make the extraction method's accuracy measurable — the two
things a Nature reviewer will ask for. Nothing here adds a dependency; the
provenance is already generated and then discarded.

**The finding that motivates this plan:** the pipeline captures more evidence
than it keeps, and keeps more than it publishes.

| Signal                                        | Generated         | Persisted                      | Published               |
| --------------------------------------------- | ----------------- | ------------------------------ | ----------------------- |
| `source_quote` — verbatim supporting sentence | yes, **required** | yes (`genes.source_quote`)     | **no**                  |
| `confidence` — model's own `[0.0, 1.0]` score | yes, **required** | **no**                         | no                      |
| Extended thinking — the reasoning trace       | yes, **billed**   | **no** (counted, then dropped) | no                      |
| Extraction accuracy vs gold standard          | —                 | —                              | **not measured at all** |

**Architecture:** Four independent tasks. Task 1 is blocked on a live export run
(see Prerequisite). Tasks 2–4 are independent of each other and of Task 1. None
touches the retrieval or Docling paths.

**Tech Stack:** unchanged — Python 3.14, uv, ruff, ty, pytest, asyncpg, pydantic
2, alembic, anthropic SDK; Deno 2 / Fresh 2 on the consumer side (Tasks 1 and 2
only).

---

## Global Constraints

- **No new runtime dependencies.** Every capability here already exists in the
  codebase; this plan connects wires, it does not add any.
- **The JSON contract is byte-exact.** `tests/pipeline/export/test_writer.py`
  parses each `data/*.json`, re-encodes it through `pipeline/export/writer.py`'s
  writer and compares **bytes**. A companion test fails if a file appears in
  `data/` with no case. Any key added to `table1.json` must be regenerated, not
  hand-edited.
- **`lib/` requires 100% coverage** (`deno.json` `test:coverage`), so any
  addition to `lib/tooltips.ts` or `lib/types.ts` needs matching tests.
- **Python floor is 99.5%** line+branch (`[tool.coverage.report] fail_under`).
- **Wire keys derive from display names.** `to_camel()` in
  `pipeline/export/writer.py` turns `"Source Quote"` into `sourceQuote`; keep
  `lib/types.ts` and the `islands/*View.tsx` column definitions in sync (the
  three-layer table in `CLAUDE.md`).

---

## Prerequisite — a latent export break, to be decided deliberately

`pipeline/export/main.py:27` drops only database metadata:

```python
_METADATA_COLUMNS = frozenset({"id", "created_at", "updated_at"})
```

and `main.py:35` reads `SELECT * FROM genes`. Migration
`004_add_source_quote.py` added `genes.source_quote` **after** the committed
`data/table1.json` was produced, so that column will flow into
`clean_gene_row()` on the first real export and add a `sourceQuote` key to
`table1.json`.

`CLAUDE.md` states: _"The first `deno task data` should leave `git diff data/`
empty; anything else is a divergence no test could have seen."_ **It will not be
empty.** This is that divergence, found in advance.

- [ ] Decide, before the first `deno task data`: **publish** `sourceQuote`
      (Task 1) or **suppress** it by adding `source_quote` to
      `_METADATA_COLUMNS`. Do not discover this as a mystery diff.
- [ ] Whichever way it goes, record the decision in `CLAUDE.md` beside the
      byte-exact note, so the next person does not re-litigate it.

> Recommendation: publish. The suppression path throws away the strongest
> transparency artifact the pipeline has.

---

## Task 1 — Publish the supporting sentence

**Why:** `pipeline/extraction_models.py:33` makes the quote mandatory, with the
reason recorded in the source:

```python
# Verbatim sentence from the paper supporting this entry. Required: the
# Citations API cannot be combined with structured outputs (400), so
# provenance has to travel inside the schema.
source_quote: str = Field(min_length=1)
```

The v6 prompt demands a verbatim sentence and forbids paraphrase;
`PROMPT_VERSIONS_WITHOUT_PROVENANCE` (`pipeline/prompts.py:849`) refuses prompt
versions that predate the instruction, precisely so the field cannot fill with
plausible-looking invention. `data_merger.py:86` carries it first-occurrence-
wins. `database.py:279` backfills it with `COALESCE(NULLIF(...))`. Eight test
modules pin it.

Today a dashboard reader gets `references` — paper-level citation — but never
the sentence. Publishing it turns "this gene is associated with this trait, per
PMID X" into "…, and here is the sentence in PMID X that says so."

- [ ] Confirm `clean_gene_row()` passes `source_quote` through unmodified, or
      add explicit cleaning consistent with `pipeline/export/text.py` (trim only
      — never truncate; a truncated quote is not verbatim).
- [ ] Regenerate `data/table1.json` via `deno task data` against the live
      database; commit the regenerated file, not a hand-edit.
- [ ] Add `sourceQuote: string` to the `Gene` shape in `lib/types.ts`.
- [ ] Normalize at the boundary in `lib/data.ts`, as the other display strings
      are, so a partially generated file cannot poison the UI.
- [ ] Surface it in `islands/GenesView.tsx`. **Reuse the existing tooltip
      stack** — `lib/tooltips.ts` builds structured `TooltipContent`,
      `components/Tooltip.tsx` renders it as JSX with the native `[popover]`
      arrangement. Do not write new tooltip code.
- [ ] Extend `tests/data_contract_test.ts`: every row carries a non-blank
      `sourceQuote`. It is a plain string — neither a list-column nor a sentinel
      — so state that explicitly rather than leaving it to inference.
- [ ] Add the `sourceQuote` case to `tests/pipeline/export/test_writer.py`.
- [ ] Tests for the new `lib/` code paths (100% floor).

**Open question for the author:** quotes are full sentences and the genes table
is dense. Tooltip-on-hover keeps the table readable; an expandable row shows
more but costs layout. Decide before building the UI half.

---

## Task 2 — Persist and publish the model's confidence

**Why:** `GeneEntry.confidence` is required and bounded (`ge=0.0, le=1.0`), but
it reaches nothing. The `genes` table
(`pipeline/alembic/versions/001_baseline_schema.py:27-42`, plus migration 004)
has no such column, and the dict built by `data_merger.py:70-87` has no
`confidence` key. The model scores every extraction and the score is dropped on
the floor.

For a publication this is the difference between "the pipeline reported 63
genes" and "the pipeline reported 63 genes, of which N were high-confidence."

- [ ] Write `pipeline/alembic/versions/005_add_confidence.py`, matching the
      `ADD COLUMN IF NOT EXISTS` / `DROP COLUMN IF EXISTS` shape of migration
      004. Add its case to `tests/pipeline/test_alembic_migrations.py:19`.
- [ ] Decide the merge rule and write it down. Genes merge across papers, so
      `confidence` needs one: `max`, `min`, or first-occurrence-wins to match
      `source_quote`. **Recommendation: keep it beside its quote** — the same
      first-occurrence entry — so the published confidence and the published
      sentence describe the same extraction rather than two different papers.
- [ ] Carry it through `data_merger.py`, `database.py` (insert + update SQL,
      following the existing `COALESCE` backfill pattern), and the export.
- [ ] `lib/types.ts`, `lib/data.ts` boundary, `islands/GenesView.tsx`, and the
      contract test — as Task 1.

---

## Task 3 — Retain the reasoning trace for audit

**Why:** `pipeline/anthropic_client.py:56-68` counts thinking and keeps text:

```python
case "thinking":
    thinking_chars += len(getattr(block, "thinking", ""))   # counted, discarded
case "text":
    text_parts.append(block_text)                            # kept
```

The pipeline runs with adaptive extended thinking (`config.thinking_config`,
`thinking_mode`), pays for those tokens, uses the count for cost accounting, and
throws the content away.

**Scientific caveat, and it is load-bearing:** an extended-thinking block is
**not** a verified causal account of how the model reached its answer.
Presenting one in a peer-reviewed paper as "the reason this gene was extracted"
would be a claim that cannot be defended. Store it as an **audit trail** — what
the run produced, retained for inspection — and let `source_quote` remain the
cited evidence. This distinction belongs in the code comment, not only here.

- [ ] Retain the thinking text in `_extract_response_text`. Widen the `match` to
      handle `redacted_thinking` blocks as well — the current statement handles
      only `thinking` and `text`, and a redacted block would be counted as
      neither.
- [ ] **Decide where it goes.** Two candidates: - `pipeline/event_log.py` —
      already the "append-only audit log" abstraction, already wired
      (`main.py:622-623`), already documented as _"payloads are for human audit,
      not round-trip typed."_ Today it records one `pipeline_completed` event
      per run; this adds a per-paper event type. Cheapest, and semantically the
      right home. - A new Postgres `extraction_audit` table keyed by
      `(pmid, run)` — queryable alongside `genes`, but a migration, a write
      path, and volume in the production database. **Recommendation: the event
      log.** It is an audit artifact, not dashboard data, and
      `config.event_db_path` already keeps it out of Postgres.
- [ ] Size guard. Thinking traces are large. Cap per-entry length or rotate, and
      confirm the SQLite log stays reasonable across a full run.
- [ ] **Never publish it.** No `data/*.json` key, no `lib/types.ts` field.
- [ ] Add a `conftest.py` autouse reset if any new module-level state appears
      (the ten existing singleton resets at `tests/pipeline/conftest.py:206-336`
      are the established convention).

---

## Task 4 — Measure extraction accuracy

**Why:** this is the task that makes the other three credible. Provenance shows
_what_ was extracted; only this shows _how often it is right_. `CLAUDE.md` is
blunt about the current state:

> _"All eleven substantive tests in `tests/pipeline/test_extraction_golden.py`
> skip — there are no paper fixtures and no VCR cassettes... Nothing in CI
> measures extraction quality, and the 1,360-line harness that used to was
> deleted with the tuning tooling. Do not read a green run as evidence that a
> prompt or schema change left extraction intact."_

Everything needed is already scaffolded:
`data/test_data/gold_standard/gold_standard_v2.csv`, a working F1 scorer (among
the six tests that do run), `pytest-recording` configured, and the module-scoped
`vcr_config` fixture at `tests/pipeline/conftest.py:344-361` filtering
`x-api-key` and `authorization`. Only the fixtures and cassettes are missing.

`tests/pipeline/cassettes/.gitkeep` is empty and
`tests/pipeline/fixtures/papers/` does not exist.

- [ ] **Blocker to clear first:** recording needs a real `ANTHROPIC_API_KEY`.
      The committed `.env` currently holds only the five `DB_*` keys.
- [ ] Choose the fixture papers. They should span the corpus honestly — Europe
      PMC full text _and_ PDF-fallback papers, positive and negative cases — not
      only the easy ones. Record the selection rationale in the module
      docstring; a gold standard whose sampling is undocumented is not a gold
      standard.
- [ ] Record cassettes with `--record-mode=once`. Confirm the header filtering
      actually stripped the key **before committing** — inspect the cassette
      files by hand, once.
- [ ] Verify the eleven tests now run:
      `uv run pytest -rs
      tests/pipeline/test_extraction_golden.py` should
      report zero skips from `_missing_prerequisites()` / `requires_recording`.
- [ ] Establish the baseline F1 and record it, so a prompt or model change is
      measurable rather than a matter of opinion.
- [ ] Update `CLAUDE.md`'s "What is not proven" — the first bullet becomes false
      once this lands, and a stale one is worse than none.

---

## Verification

```bash
# Python: lint, types, tests, coverage floor
uv run ruff check .
uv run ty check
uv run pytest -rs --cov=pipeline --cov=pipeline/alembic --cov-branch

# The export gate — must be byte-exact against the regenerated files
uv run pytest tests/pipeline/export/test_writer.py

# Deno: contract, unit, coverage (lib/ at 100%), and the full check task
deno task check
deno task test:coverage
deno test -A tests/data_contract_test.ts

# End to end
deno task data && git diff --stat data/     # expected to change ONLY in Tasks 1-2
deno task build && deno task test:e2e
```

Manual checks no test can make:

1. **The published quote is verbatim.** Pick three genes at random, open the
   cited PMID, and confirm the sentence appears in the paper as published. This
   is the claim the transparency story rests on; automate nothing about it.
2. **No key leaked into a cassette.** Inspect the recorded files by hand once,
   before the first commit that includes them.
3. **The reasoning trace is not published.** Grep every `data/*.json` for
   thinking content after a full run.
