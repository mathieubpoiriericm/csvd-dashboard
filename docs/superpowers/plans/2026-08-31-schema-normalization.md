# Schema Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move three delimited lists out of `genes` TEXT columns into join
tables, one value per row, so the corruption that destroyed ten `references`
cells becomes structurally impossible rather than merely guarded against.

**The finding that motivates this plan.** `pipeline/CLAUDE.md`'s "Known data
limitation" section records that `genes.references` was destroyed for ten rows
when a comma-separated PMID list was opened in a spreadsheet, parsed as one
number and re-rendered with thousands separators (`HTRA1` read
`2,606,365,833,773,630,000,...`). Recovery took float64 significant-digit
analysis plus per-candidate NCBI verification, and `HTRA1` still carries three
references because one lost digit was genuinely ambiguous.

The bug was not the spreadsheet. It was that the schema stored a list in a
scalar column. `extract_pmids_or` now refuses a mangled cell, which converts the
failure from silent fabrication into a visible `(reference needed)` — a guard,
not a fix. **A table with one PMID per row cannot be parsed as a single
number.** That is the fix.

Three columns share the defect:

| Column                        | Holds                  | Wire field                         |
| ----------------------------- | ---------------------- | ---------------------------------- |
| `references`                  | comma-separated PMIDs  | `references: string[]`             |
| `gwas_trait`                  | comma-separated traits | `gwasTrait: string[]`              |
| `link_to_monogenetic_disease` | OMIM IDs in prose      | `linkToMonogenicDisease: string[]` |

**Architecture:** Expand/contract, in five steps. Migration 005 adds the join
tables without touching the old columns; a backfill populates them using the
_same_ parsing functions the export already applies; the export switches to
reading the tables; the ingest starts writing them alongside the old columns;
migration 006 drops the old columns and the last writers of them. Task 6 is an
independent type fix.

**The wire format does not change.** These fields are already JSON arrays —
`pipeline/export/tables.py` splits the delimited text on the way out. Only
_storage_ is wrong. That is what makes the **export** half of this refactor
safe: **the byte-exact JSON gate is a perfect oracle for it.** If
`data/table1.json` regenerates byte-identical after the switch, the export side
of the normalization is proven faithful. No TypeScript, no island, and no filter
changes.

**The gate does not reach the ingest, and that is the risk in this plan.**
`pipeline/database.py`'s `merge_genes_transactional` writes all three columns,
and its union-dedup SQL is built entirely out of `string_to_array` /
`string_agg` over the delimited text. Nothing in `data/*.json` moves when that
SQL breaks, because the export reads the database rather than the merge. Worse,
`pipeline/CLAUDE.md` records that this SQL "still has not run against this
database with a non-empty batch" — so a break there stays invisible until the
next real ingest run. Task 4 exists for that, and Task 5 must not land without
it.

**Tech Stack:** unchanged — Python 3.14, uv, alembic, asyncpg, pytest, ruff, ty;
Deno 2 / Fresh 2 untouched by this plan.

**Spec:** none separate. This plan argues from `pipeline/CLAUDE.md`'s "Known
data limitation" section and the schema captured by commit `f5f9380`, which
verified the live schema matches migrations 001–004.

---

## Global Constraints

- **The JSON contract is byte-exact.** `tests/pipeline/export/test_writer.py`
  parses each `data/*.json`, re-encodes it through `pipeline/export/writer.py`
  and compares **bytes**. `data/table1.json` must regenerate byte-identical.
  This is the plan's primary safety gate for the export — never hand-edit the
  file to make it match.
- **The byte-exact gate covers the export only.** It says nothing about
  `pipeline/database.py` or `pipeline/data_merger.py`. Those are covered by
  `tests/pipeline/test_database.py` and `tests/pipeline/test_data_merger.py`,
  which assert SQL _shape_ against a mocked connection — so they catch a
  forgotten clause but not a type error PostgreSQL would raise. The throwaway
  container in Task 1 is what proves the SQL actually runs.
- **JSON key order is the published column order.** `clean_gene_row` builds its
  output dict from the incoming row's key order (`tables.py:153`), hoisting
  `gene` to the front, and `write_rows` serialises insertion order verbatim.
  `data/table1.json` is therefore in `genes`' column order, and
  `tests/pipeline/export/test_tables.py:90` pins it against the committed file.
  Any change to how a gene row is read must preserve that order — including
  after migration 006 removes three of those columns.
- **Python coverage floor is 99.5%** line+branch
  (`[tool.coverage.report] fail_under`). CI measures `pipeline` _and_
  `pipeline/alembic` with `--cov-branch`, so every new migration needs a case in
  the parametrize list at `tests/pipeline/test_alembic_migrations.py:15-20`.
  Coverage comes from tests, not from production call sites: a helper whose only
  caller ends up in `scripts/` still needs its test under `tests/pipeline/`,
  because `tests/scripts/` is outside `testpaths` and never runs in CI.
- **Every export query needs an `ORDER BY`.** Without one PostgreSQL returns
  rows in arbitrary physical order and the byte-exact contract cannot hold. The
  join tables are ordered by `(gene_id, ordinal)`.
- **Sentinels stay in the presentation layer.** `"(none found)"` and
  `"(reference needed)"` are produced by `fill_missing_text` /
  `extract_pmids_or` at export time from NULL or empty input — they are _not_
  stored today and must not become stored. A gene with no references gets **zero
  rows** in `gene_references`, and the export renders the sentinel. The converse
  matters too: `fill_missing_text`'s `"NA"` / `"N/A"` fold must happen _before_
  a value reaches a join table, or the sentinel input becomes a stored trait.
- **Migrations are raw SQL through `op.execute()`.** No SQLAlchemy models;
  `target_metadata=None`. Follow the shape of
  `pipeline/alembic/versions/004_add_source_quote.py`. Ruff does not lint
  `pipeline/alembic` (`extend-exclude`).
- **`deno fmt` reaches `data/`.** It is not excluded in `deno.json`, and
  `deno task check` runs `deno fmt --check .`. The writer's output is already
  fmt-clean, so do **not** run `deno fmt data/` to make a regeneration pass: if
  fmt would change a file the writer produced, that is a writer divergence to
  fix, not formatting to apply.
- **Migration numbering:** next free revision is `005`. `down_revision` chains
  from `004`.

## Out of Scope, Deliberately

**`evidence_from_other_omics_studies` is not normalized here.** It looks like
the same defect but is not. `clean_omics_value`
(`pipeline/export/tables.py:111-141`) runs a fifteen-step transformation chain —
deleting tissue tokens, folding separators, rewriting a whole sentence to a
label, then sweeping the debris those deletions leave behind. That is free-text
prose being coerced into a list, so deciding what one "entry" is would be a
curation judgment, not a schema change. Normalizing it needs a curator, and
belongs in its own plan. Its union-dedup SQL in `merge_genes_transactional`
stays exactly as it is.

**`clinical_trials.genetic_target` is not normalized here.** It is delimited
(`split_genetic_targets` splits it for the lookup request lists) but publishes
as a **scalar** `geneticTarget: string`, so a join table would not simplify the
export — it would add a join and then re-join the string. Lower value, higher
churn; revisit only if it starts holding many targets.

**No foreign key from `gene_references.pmid` to `pubmed_citations.pmid`.** The
citations table is a lookup _cache_, not a registry of every cited paper; a
reference may legitimately have no cached citation, so that constraint would
fail on correct data.

**`gene_monogenic_links` gets no ingest writer.** `_build_combined_gene_data`
sets `link_to_monogenetic_disease` to `""` unconditionally
(`pipeline/data_merger.py:105`) — the extraction has never produced OMIM links,
they are curator-entered. Task 4 therefore writes two of the three join tables,
and Task 5 deletes the always-empty field rather than porting it.

---

## File Structure

| File                                                               | Responsibility                                                                   |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `pipeline/alembic/versions/005_normalize_gene_lists.py`            | Create three join tables (additive only)                                         |
| `pipeline/alembic/versions/006_drop_gene_list_columns.py`          | Drop the three source columns                                                    |
| `pipeline/alembic/versions/007_mendelian_randomization_boolean.py` | Type fix                                                                         |
| `pipeline/export/text.py`                                          | Split `extract_pmids` / `extract_matches` out of their `_or` wrappers            |
| `pipeline/export/tables.py`                                        | `split_gwas_traits` helper; `clean_gene_row` consumes lists instead of splitting |
| `pipeline/export/main.py`                                          | Read the join tables and attach them to gene rows, at their published positions  |
| `pipeline/data_merger.py`                                          | Build `gwas_trait` / `references` as lists rather than joined strings            |
| `pipeline/database.py`                                             | Append the incoming lists into the join tables inside the merge transaction      |
| `scripts/backfill_gene_lists.py`                                   | One-off backfill from the TEXT columns                                           |
| `tests/pipeline/export/test_text.py`                               | Cases for the new no-fallback functions                                          |
| `tests/pipeline/export/test_tables.py`                             | `clean_gene_row` over pre-split lists; `split_gwas_traits`                       |
| `tests/pipeline/export/test_export_main.py`                        | Join-table read path, and the published column order                             |
| `tests/pipeline/test_data_merger.py`                               | List-valued `gwas_trait` / `references`                                          |
| `tests/pipeline/test_database.py`                                  | Append SQL shape, ordinals, idempotency                                          |
| `tests/pipeline/test_alembic_migrations.py`                        | One parametrize case per new revision                                            |
| `tests/scripts/test_backfill_gene_lists.py`                        | Backfill parsing, ordering, empty-list handling                                  |

---

### Task 1: Add the join tables (additive)

**Files:**

- Create: `pipeline/alembic/versions/005_normalize_gene_lists.py`
- Modify: `tests/pipeline/test_alembic_migrations.py:15-20`

**Interfaces:**

- Consumes: nothing.
- Produces: tables `gene_references(gene_id, ordinal, pmid)`,
  `gene_gwas_traits(gene_id, ordinal, trait)`,
  `gene_monogenic_links(gene_id, ordinal, omim_id)`. Each has
  `PRIMARY KEY (gene_id, ordinal)` and
  `gene_id INTEGER NOT NULL REFERENCES genes(id) ON DELETE CASCADE`.

`ordinal` rather than `position`: `POSITION` is a SQL keyword (the
`POSITION(x IN y)` function), and while PostgreSQL accepts it as a column name
it needs quoting in some contexts. `ordinal` avoids the question. It is
**load-bearing**, not decorative — the JSON arrays must keep source order for
the byte-exact gate to hold, and `extract_pmids_or` preserves source order today
via an insertion-ordered dict (`pipeline/export/text.py:190-193`).

- [ ] **Step 1: Write the failing test**

Add to the parametrize list at
`tests/pipeline/test_alembic_migrations.py:15-20`:

```python
("005_normalize_gene_lists.py", "CREATE TABLE", "DROP TABLE"),
```

- [ ] **Step 2: Run it to verify it fails**

Run: `uv run pytest tests/pipeline/test_alembic_migrations.py -v` Expected: FAIL
— `FileNotFoundError` on `005_normalize_gene_lists.py`.

- [ ] **Step 3: Write the migration**

Create `pipeline/alembic/versions/005_normalize_gene_lists.py`:

```python
"""Normalize the genes list-columns into join tables.

Three columns on `genes` hold delimited lists inside TEXT: `references`
(comma-separated PMIDs), `gwas_trait`, and `link_to_monogenetic_disease`.
The first has already been destroyed once -- a spreadsheet round-trip read
the whole PMID list as one number for ten rows -- and one value per row
makes that class of corruption impossible rather than merely detectable.

This revision is additive. The source columns stay until 006, so the
backfill, the export switch and the ingest switch can land between the two
and be verified against the byte-exact JSON gate before anything is dropped.

`ordinal` preserves source order, which the JSON arrays depend on.

Revision ID: 005
Revises: 004
Create Date: 2026-08-31
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "005"
down_revision: str | None = "004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS gene_references (
            gene_id INTEGER NOT NULL REFERENCES genes(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL,
            pmid VARCHAR(20) NOT NULL,
            PRIMARY KEY (gene_id, ordinal)
        )
    """)
    op.execute("""
        CREATE TABLE IF NOT EXISTS gene_gwas_traits (
            gene_id INTEGER NOT NULL REFERENCES genes(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL,
            trait VARCHAR(100) NOT NULL,
            PRIMARY KEY (gene_id, ordinal)
        )
    """)
    op.execute("""
        CREATE TABLE IF NOT EXISTS gene_monogenic_links (
            gene_id INTEGER NOT NULL REFERENCES genes(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL,
            omim_id VARCHAR(20) NOT NULL,
            PRIMARY KEY (gene_id, ordinal)
        )
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS gene_monogenic_links")
    op.execute("DROP TABLE IF EXISTS gene_gwas_traits")
    op.execute("DROP TABLE IF EXISTS gene_references")
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `uv run pytest tests/pipeline/test_alembic_migrations.py -v` Expected:
PASS, 5 revision cases.

- [ ] **Step 5: Prove it applies to a real database**

The migrations must build from empty, as `001_baseline_schema.py:3-5` claims and
commit `f5f9380` verified. Use a throwaway container, never the real server:

```bash
docker run -d --rm --name csvd-migrate-check \
  -e POSTGRES_USER=csvd_user -e POSTGRES_PASSWORD=ephemeral \
  -e POSTGRES_DB=csvd_check -p 55432:5432 postgres:18.6
```

```bash
DB_HOST=localhost DB_PORT=55432 DB_NAME=csvd_check \
DB_USER=csvd_user DB_PASSWORD=ephemeral \
  uv run alembic -c pipeline/alembic.ini upgrade head
```

Expected: `Running upgrade 004 -> 005`. Then verify `downgrade` is real:

```bash
DB_HOST=localhost DB_PORT=55432 DB_NAME=csvd_check \
DB_USER=csvd_user DB_PASSWORD=ephemeral \
  uv run alembic -c pipeline/alembic.ini downgrade -1
```

Expected: clean. Re-run `upgrade head` and **leave the container running** — it
is the SQL proving ground for Tasks 3, 4 and 5. Stop it with
`docker stop csvd-migrate-check` when Task 5 finishes.

- [ ] **Step 6: Commit**

```bash
git add pipeline/alembic/versions/005_normalize_gene_lists.py tests/pipeline/test_alembic_migrations.py
git commit -m "Add join tables for the three genes list-columns"
```

---

### Task 2: Split the extractors from their fallbacks, and backfill

**Files:**

- Modify: `pipeline/export/text.py` (`extract_pmids_or`, `extract_matches_or`)
- Modify: `pipeline/export/tables.py` (add `split_gwas_traits`)
- Create: `scripts/backfill_gene_lists.py`
- Modify: `tests/pipeline/export/test_text.py`,
  `tests/pipeline/export/test_tables.py`
- Create: `tests/scripts/test_backfill_gene_lists.py`

**Interfaces:**

- Consumes: the three tables from Task 1.
- Produces:
  - `extract_pmids(value: str | None) -> list[str]` — source order, `[]` when
    none.
  - `extract_matches(value: str | None, pattern: re.Pattern[str]) -> list[str]`
    — `[]` when none.
  - `split_gwas_traits(value: str | None) -> list[str]` — canonical labels, `[]`
    when none.
  - `extract_pmids_or` / `extract_matches_or` keep their current signatures and
    behaviour, now as one-line wrappers. This task changes no behaviour at all;
    Task 3 deletes the wrappers when their last caller goes.

The backfill must reuse these exact functions. Reimplementing the parsing would
let the join tables disagree with the JSON, and the byte-exact gate in Task 3
would then fail with no obvious cause.

- [ ] **Step 1: Write the failing tests**

Add to `tests/pipeline/export/test_text.py`:

```python
def test_extract_pmids_returns_empty_list_when_nothing_matches() -> None:
    assert extract_pmids(None) == []
    assert extract_pmids("no identifiers here") == []


def test_extract_pmids_preserves_source_order_and_dedupes() -> None:
    assert extract_pmids("33773636, 32358547, 33773636") == [
        "33773636",
        "32358547",
    ]


def test_extract_pmids_still_refuses_a_mangled_thousands_run() -> None:
    """The corruption guard must survive the refactor."""
    assert extract_pmids("2,606,365,833,773,630,000") == []


def test_extract_pmids_or_still_falls_back_to_the_sentinel() -> None:
    assert extract_pmids_or(None, "(reference needed)") == ["(reference needed)"]
```

And to `tests/pipeline/export/test_tables.py` — these live under
`tests/pipeline/` deliberately, because after Task 3 `split_gwas_traits`' only
production caller is `scripts/backfill_gene_lists.py`, which `--cov=pipeline`
does not measure and CI never runs:

```python
def test_split_gwas_traits_folds_synonyms_in_source_order() -> None:
    assert split_gwas_traits("small vessel stroke, WMH") == ["SVS", "WMH"]


def test_split_gwas_traits_trims_the_whole_cell_before_splitting() -> None:
    """clean_gene_row applied normalize_text first, and _SPLIT_ON_COMMA
    reaches neither the first part's leading nor the last part's trailing
    whitespace. "PSMD " is a real stored value, not a hypothetical."""
    assert split_gwas_traits("  PSMD , WMH  ") == ["PSMD", "WMH"]


def test_split_gwas_traits_treats_the_missing_sentinels_as_no_traits() -> None:
    """fill_missing_text's fold has to happen before a value is stored:
    without it "NA" backfills as the trait "NA" and publishes as ["NA"]
    where the export has always emitted ["(none found)"]."""
    assert split_gwas_traits(None) == []
    assert split_gwas_traits("") == []
    assert split_gwas_traits("NA") == []
    assert split_gwas_traits("n/a") == []
```

- [ ] **Step 2: Run them to verify they fail**

Run:
`uv run pytest tests/pipeline/export/ -k "extract_pmids or split_gwas_traits" -v`
Expected: FAIL — `ImportError: cannot import name 'extract_pmids'` and
`'split_gwas_traits'`.

- [ ] **Step 3: Refactor the extractors**

In `pipeline/export/text.py`, rename the existing body of `extract_pmids_or`
(`text.py:163-193`) to `extract_pmids`, dropping both fallback returns, and add
a wrapper. The docstring's corruption note moves with the body:

```python
def extract_pmids(value: str | None) -> list[str]:
    """Extract PubMed IDs without mistaking years or DOI fragments for them.

    Short IDs are accepted only when a PubMed URL, a PMID label, or an
    all-numeric cell makes their meaning explicit. Unlabelled prose keeps a
    seven-digit floor. The marker pass preserves source order across the two
    explicit forms and the bare-number scan.

    A cell that is one thousands-separated number is refused outright: it is
    a PMID list a spreadsheet has destroyed, not a list of short PMIDs.
    Returns an empty list when nothing matches.
    """
    if value is None:
        return []
    # Drop mangled runs before anything else, so what survives is only the
    # part of the cell that was never a spreadsheet-formatted number.
    value = _THOUSANDS_RUN.sub(" ", value)

    marked = _PUBMED_URL.sub(rf" {_MARKER}\1 ", value)
    marked = _LABELLED_PMID.sub(rf" {_MARKER}\1 ", marked)

    # Strip URLs and DOIs before scanning prose: DOI suffixes often carry
    # long numeric fragments that look like modern PMIDs.
    remainder = _URL.sub(" ", marked)
    remainder = _DOI_LABEL.sub(" ", remainder)
    remainder = _DOI_BARE.sub(" ", remainder)

    pattern = _ANY_NUMBER if _NUMERIC_LIST.match(remainder) else _MARKED_OR_LONG
    seen: dict[str, None] = {}
    for candidate in pattern.findall(remainder):
        seen.setdefault(candidate.removeprefix(_MARKER), None)
    return list(seen)


def extract_pmids_or(value: str | None, fallback: str) -> list[str]:
    """Extract PubMed IDs, or one sentinel when the cell yields none."""
    return extract_pmids(value) or [fallback]
```

The only changes from today's body are the two return statements: `[fallback]`
becomes `[]`, and the trailing `if seen else [fallback]` conditional is dropped
because the wrapper now supplies it.

Apply the identical treatment to `extract_matches_or` (`text.py:145-160`) →
`extract_matches` plus wrapper.

- [ ] **Step 4: Add the trait splitter**

In `pipeline/export/tables.py`, lift the splitting out of `clean_gene_row` (the
list comprehension at `tables.py:156-164`) into a reusable function. It must
reproduce **both** of the steps that run ahead of that comprehension today —
`normalize_text` at `tables.py:146`, and `fill_missing_text` at `tables.py:156`
— because it now feeds storage rather than display:

```python
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
```

Two guards rather than one compound condition, because `--cov-branch` wants both
reachable and the tests above reach them separately: `""` normalizes to `None`
and takes the first, `"NA"` takes the second. Do not restate the sentinel set as
a literal here — routing through `fill_missing_text` is what keeps the storage
rule and the display rule from drifting apart.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest tests/pipeline/export/ -v` Expected: PASS, including every
pre-existing case — the wrappers preserve current behaviour exactly and
`clean_gene_row` has not moved yet.

- [ ] **Step 6: Write the backfill script**

Create `scripts/backfill_gene_lists.py`. Note where each name comes from:
`_OMIM_ID` is defined in `pipeline/export/tables.py:24`, not in `text.py`, and
the connection manager is `Database` (`pipeline/database.py:25`), the same class
`pipeline/export/main.py:14` imports:

```python
"""Backfill the gene list join tables from the legacy TEXT columns.

One-off, idempotent, and safe to re-run: each table is emptied and rewritten
inside one transaction. It reuses the export's own parsers, so the join
tables and data/table1.json cannot disagree.

A gene whose cell yields nothing gets zero rows -- the sentinel stays a
presentation concern, produced by the export, never stored.

    uv run scripts/backfill_gene_lists.py [--dry-run]
"""

import argparse
import asyncio
from pathlib import Path

from dotenv import load_dotenv

from pipeline.database import Database
from pipeline.export.tables import _OMIM_ID, split_gwas_traits
from pipeline.export.text import extract_matches, extract_pmids, normalize_text

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

# (join table, value column, source column, parser). Every parser is the one
# the export itself applies, so a disagreement between the join tables and
# data/table1.json is impossible by construction rather than by review.
_TARGETS = (
    ("gene_references", "pmid", "references", extract_pmids),
    ("gene_gwas_traits", "trait", "gwas_trait", split_gwas_traits),
    (
        "gene_monogenic_links",
        "omim_id",
        "link_to_monogenetic_disease",
        lambda v: extract_matches(v, _OMIM_ID),
    ),
)


async def backfill(dry_run: bool = False) -> dict[str, int]:
    counts: dict[str, int] = {}
    async with Database.connection() as conn:
        rows = await conn.fetch(
            'SELECT id, "references", gwas_trait, link_to_monogenetic_disease '
            "FROM genes ORDER BY id"
        )
        for table, column, source, parse in _TARGETS:
            written = 0
            async with conn.transaction():
                if not dry_run:
                    await conn.execute(f"DELETE FROM {table}")  # noqa: S608
                for row in rows:
                    # normalize_text mirrors clean_gene_row's first step
                    # (tables.py:146): the export has always parsed the
                    # trimmed cell, so the backfill must too.
                    for ordinal, value in enumerate(parse(normalize_text(row[source]))):
                        written += 1
                        if not dry_run:
                            await conn.execute(
                                f"INSERT INTO {table} (gene_id, ordinal, {column}) "  # noqa: S608
                                "VALUES ($1, $2, $3)",
                                row["id"],
                                ordinal,
                                value,
                            )
            counts[table] = written
    return counts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    for table, count in asyncio.run(backfill(args.dry_run)).items():
        print(f"{table}: {count} rows")


if __name__ == "__main__":
    main()
```

The table and column names are interpolated from the module-level `_TARGETS`
constant, never from input. The `noqa: S608` comments are documentation rather
than suppression — ruff's `select` is `["E", "F", "I", "UP", "B", "SIM"]`
(`pyproject.toml:95`), so flake8-bandit is not enabled and nothing currently
checks that rule; they mark the interpolation for a reader, and for the day `S`
is turned on.

- [ ] **Step 7: Write the backfill tests**

Create `tests/scripts/test_backfill_gene_lists.py`. Note `tests/scripts` is
**not** in `testpaths` and does not run in CI — run it explicitly. It exists to
cover the script's own wiring; the parsers themselves are covered under
`tests/pipeline/export/`:

```python
"""Coverage for the gene-list backfill."""

import runpy
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "backfill_gene_lists.py"


def test_parsers_agree_with_the_export_for_a_mangled_cell() -> None:
    """The corruption case must produce zero rows, never a fabricated PMID."""
    namespace = runpy.run_path(str(_SCRIPT))
    _, _, _, parse = namespace["_TARGETS"][0]
    assert parse("2,606,365,833,773,630,000") == []


def test_ordinals_start_at_zero_and_follow_source_order() -> None:
    namespace = runpy.run_path(str(_SCRIPT))
    _, _, _, parse = namespace["_TARGETS"][0]
    assert list(enumerate(parse("33773636, 32358547"))) == [
        (0, "33773636"),
        (1, "32358547"),
    ]


def test_every_target_names_a_column_the_genes_table_has() -> None:
    """The SELECT is written out by hand; _TARGETS must not drift from it."""
    namespace = runpy.run_path(str(_SCRIPT))
    sources = {source for _, _, source, _ in namespace["_TARGETS"]}
    assert sources == {"references", "gwas_trait", "link_to_monogenetic_disease"}
```

- [ ] **Step 8: Run the tests**

Run: `uv run pytest tests/scripts/test_backfill_gene_lists.py -v` Expected:
PASS.

- [ ] **Step 9: Commit**

```bash
git add pipeline/export/text.py pipeline/export/tables.py scripts/backfill_gene_lists.py tests/
git commit -m "Split the list extractors from their sentinel fallbacks and add the backfill"
```

---

### Task 3: Switch the export to read the join tables

**Files:**

- Modify: `pipeline/export/main.py` (add `_GENE_COLUMNS`, `_publishable`,
  `_read_genes_with_lists`)
- Modify: `pipeline/export/tables.py:144-189` (`clean_gene_row` consumes lists)
- Modify: `pipeline/export/text.py` (delete the two `_or` wrappers)
- Modify: `tests/pipeline/export/test_tables.py`, `test_export_main.py`,
  `test_text.py`

**Interfaces:**

- Consumes: the tables from Task 1, populated by Task 2's backfill. It consumes
  none of Task 2's parsers — after this task the export does no parsing at all,
  which is the point.
- Produces: `clean_gene_row` accepts rows whose `references`, `gwas_trait` and
  `link_to_monogenetic_disease` keys hold `list[str]` or `None`, and applies
  only the sentinel fallback.
  `_read_genes_with_lists() -> list[dict[str, object]]`, ordered by `genes.id`,
  with the three list keys attached **at their published positions**.
  `_publishable(row) -> dict[str, object]` factors out the column filter that
  `_read_table` applies today.

**This is the task the byte-exact gate exists for.** After it,
`data/table1.json` must regenerate with a zero-byte diff.

- [ ] **Step 1: Write the failing tests**

Add to `tests/pipeline/export/test_tables.py`:

```python
def test_clean_gene_row_applies_sentinels_to_empty_lists() -> None:
    row = {
        "gene": "HTRA1",
        "references": [],
        "gwas_trait": [],
        "link_to_monogenetic_disease": [],
        "evidence_from_other_omics_studies": None,
    }
    out = clean_gene_row(row)
    assert out["References"] == ["(reference needed)"]
    assert out["GWAS Trait"] == ["(none found)"]
    assert out["Link to Monogenic Disease"] == ["(none found)"]


def test_clean_gene_row_applies_sentinels_to_absent_lists() -> None:
    """A gene with no rows in a join table reaches clean_gene_row with None
    in that key -- the NULL placeholder _read_genes_with_lists selects."""
    out = clean_gene_row(
        {
            "gene": "HTRA1",
            "references": None,
            "gwas_trait": None,
            "link_to_monogenetic_disease": None,
            "evidence_from_other_omics_studies": None,
        }
    )
    assert out["References"] == ["(reference needed)"]
    assert out["GWAS Trait"] == ["(none found)"]


def test_clean_gene_row_passes_populated_lists_through_in_order() -> None:
    row = {
        "gene": "HTRA1",
        "references": ["33773636", "33773637"],
        "gwas_trait": ["WMH"],
        "link_to_monogenetic_disease": ["600142"],
        "evidence_from_other_omics_studies": None,
    }
    out = clean_gene_row(row)
    assert out["References"] == ["33773636", "33773637"]
    assert out["GWAS Trait"] == ["WMH"]
```

- [ ] **Step 2: Run it to verify it fails**

Run: `uv run pytest tests/pipeline/export/test_tables.py -k clean_gene_row -v`
Expected: FAIL — the current code calls `_SPLIT_ON_COMMA.split()` on a list and
raises `TypeError`.

- [ ] **Step 3: Change `clean_gene_row` to consume lists**

Replace the three splitting blocks at `pipeline/export/tables.py:156-176` with
fallback-only logic. Nothing else in the function moves — in particular the
`_RENAMES` pass stays last, because a rename must never reorder the dict
`write_rows` serialises verbatim:

```python
# The three list columns arrive already split, from their join tables.
# `or` covers both shapes a missing list takes: [] when the reader saw
# zero rows for a gene it did have rows for elsewhere, None when the
# NULL placeholder came through untouched.
out["GWAS Trait"] = out.get("GWAS Trait") or ["(none found)"]
out["Link to Monogenetic Disease"] = out.get(
    "Link to Monogenetic Disease"
) or ["(none found)"]
out["References"] = out.get("References") or ["(reference needed)"]
```

Then drop the now-unused `extract_matches_or` / `extract_pmids_or` imports from
`tables.py:15-22`. `_OMIM_ID` (`tables.py:24`) stays where it is —
`scripts/backfill_gene_lists.py` imports it.

- [ ] **Step 4: Fix the pre-existing `clean_gene_row` tests**

Five cases in `tests/pipeline/export/test_tables.py` feed raw delimited strings
and assert the split result — `:61-82` (`"small vessel stroke, WMH"` →
`["SVS", "WMH"]`), `:86`, `:104`, `:198`, `:218`. They are testing the splitting
that just moved to `split_gwas_traits`, so rewrite each to pass the list form
the reader now produces. The trait-folding assertions belong to
`split_gwas_traits`' own cases, added in Task 2; do not duplicate them here.

`test_gene_row_key_order_matches_the_committed_artifact` (`:90-118`) keeps
working unchanged in shape, but its input row must keep all ten keys — it is one
of the two guards on the published order.

- [ ] **Step 5: Delete the wrappers**

`tables.py:172,176` were the only production callers of `extract_pmids_or` and
`extract_matches_or` in the repo. With Step 3 they have none, and the sentinel
fallback now lives in `clean_gene_row` where it is applied. Delete both wrappers
from `pipeline/export/text.py`.

In `tests/pipeline/export/test_text.py`, **retarget** every case whose subject
is an extraction rule — the whole `:67-168` run — at `extract_pmids` /
`extract_matches`, replacing the `[fallback]` expectations with `[]`. **Delete**
only the two whose subject is the fallback itself:
`test_extract_pmids_or_none_returns_fallback` (`:170-172`) and the
`extract_pmids_or_still_falls_back_to_the_sentinel` case Task 2 added. Nothing
that pins the corruption guard, the seven-digit floor, the marker ordering or
the DOI stripping may be dropped in the process.

Leaving them as dead code is the alternative, and is worse: they would keep
their coverage from their own tests and read as live API forever.

- [ ] **Step 6: Add the join-table read**

`_read_table` (`main.py:49-71`) drops `id` — `_METADATA_COLUMNS` is
`frozenset({"id", "created_at", "updated_at"})` — so the merge cannot key on it
through that function. Add a sibling reader that keeps `id` long enough to join,
and factor the shared filter so the rule lives in one place.

The column list is spelled out rather than `SELECT *`, and **that is the
load-bearing part of this step.** `clean_gene_row` derives the JSON key order
from the incoming row (`tables.py:153`), so with `SELECT *` the three keys would
vanish from the projection the moment migration 006 runs, and
`published.update()` would re-add them at the _end_ of the dict — moving
`gwasTrait` and `linkToMonogenicDisease` to the tail of every row and rewriting
the whole of `data/table1.json`. Selecting them as NULL placeholders holds their
position, and makes this reader behave identically before and after the drop.

**Both halves of that were checked against `postgres:18.6` on 2026-08-31, while
writing this plan.** The projection below returns the same eleven columns in the
same order before and after `ALTER TABLE genes DROP COLUMN ...` — a literal
`NULL AS "references"` does not reference the column, so the drop cannot reach
it — and a row holding `references = 'doi:10.1000/xyz no pmid here'` came back
as `NULL`, which is the whole point: read as a real column it would have
published as a bare string in an array-typed field. The key order the constant
derives was also compared against the committed `data/table1.json` and matches
exactly.

In `pipeline/export/main.py`:

```python
_GENE_LIST_SOURCES: Final[tuple[tuple[str, str, str], ...]] = (
    ("references", "gene_references", "pmid"),
    ("gwas_trait", "gene_gwas_traits", "trait"),
    ("link_to_monogenetic_disease", "gene_monogenic_links", "omim_id"),
)

# Every published `genes` column, in the order data/table1.json carries it.
# clean_gene_row hoists "gene" to the front; the rest keep this order, and
# write_rows serialises it verbatim. The three list columns are named here
# but selected as NULL -- their values come from the join tables, and naming
# them is what holds their position once migration 006 removes them.
# source_quote is absent rather than filtered: see _UNPUBLISHED_COLUMNS.
_GENE_COLUMNS: Final[tuple[str, ...]] = (
    "protein",
    "gene",
    "chromosomal_location",
    "gwas_trait",
    "mendelian_randomization",
    "evidence_from_other_omics_studies",
    "link_to_monogenetic_disease",
    "brain_cell_types",
    "affected_pathway",
    "references",
)


def _publishable(row: Mapping[str, object]) -> dict[str, object]:
    """Drop database-only metadata and deliberately unpublished columns."""
    return {
        k: v
        for k, v in row.items()
        if k not in _METADATA_COLUMNS and k not in _UNPUBLISHED_COLUMNS
    }


def _gene_select() -> str:
    """SELECT id plus every published column, list columns as NULL."""
    listed = {key for key, _, _ in _GENE_LIST_SOURCES}
    projected = ", ".join(
        f'NULL AS "{name}"' if name in listed else f'"{name}"'
        for name in _GENE_COLUMNS
    )
    # Both names come from module constants, never from input. Quoting every
    # column keeps "references" -- a reserved word -- from needing a special
    # case.
    return f'SELECT id, {projected} FROM genes ORDER BY id'  # noqa: S608


async def _read_genes_with_lists() -> list[dict[str, object]]:
    """Read genes with their three list join tables attached, ordered by id.

    `id` is read but never published: it is the join key, and _publishable
    drops it on the way out. Both ORDER BY clauses are load-bearing -- the
    row order and the within-gene ordinal order both reach the JSON.
    """
    async with Database.connection() as conn:
        rows = [dict(r) for r in await conn.fetch(_gene_select())]
        lists: dict[int, dict[str, list[str]]] = {}
        for key, table, column in _GENE_LIST_SOURCES:
            fetched = await conn.fetch(
                f"SELECT gene_id, {column} FROM {table} "  # allowlisted above
                "ORDER BY gene_id, ordinal"
            )
            for record in fetched:
                gene_lists = lists.setdefault(record["gene_id"], {})
                gene_lists.setdefault(key, []).append(record[column])

    merged: list[dict[str, object]] = []
    for row in rows:
        published = _publishable(row)
        published.update(lists.get(row["id"], {}))
        merged.append(published)
    return merged
```

Add `from collections.abc import Mapping` and `from typing import Final` to the
imports — `main.py` currently has neither. Rewrite `_read_table`'s return
(`main.py:64-71`) to use the shared helper:

```python
return [_publishable(dict(row)) for row in rows]
```

Then replace the `genes` line at `main.py:95`:

```python
genes = [clean_gene_row(row) for row in await _read_genes_with_lists()]
```

A gene with no rows in a join table keeps the `None` its placeholder supplied,
so `clean_gene_row`'s `out.get(...) or [sentinel]` falls back — the same path an
empty list takes.

- [ ] **Step 7: Pin the published column order**

Add to `tests/pipeline/export/test_export_main.py`. This is the guard that makes
Task 5 safe, so write it before running Task 5, not after:

```python
def test_the_published_gene_columns_match_the_committed_key_order() -> None:
    """_GENE_COLUMNS is the only thing holding the JSON key order once the
    three list columns leave the table, so it is pinned against the file
    rather than against a hand-written list."""
    repo_root = Path(__file__).resolve().parents[3]
    committed = list(
        json.loads((repo_root / "data" / "table1.json").read_text(encoding="utf-8"))[0]
    )
    labels = [clean_column_name(name) for name in _GENE_COLUMNS]
    expected = [to_camel(_RENAMES.get(label, label)) for label in labels]
    expected.remove("gene")  # clean_gene_row hoists it to the front
    assert ["gene", *expected] == committed


async def test_a_gene_with_no_join_rows_keeps_its_null_placeholders(mocker) -> None:
    """The empty case must never publish a scalar. Selecting the real
    column instead of a placeholder would put the raw cell here, and the
    17 rows that read "(reference needed)" hold DOI prose, not NULL --
    they would have shipped as strings in an array-typed field.
    """
    mock_conn = AsyncMock()
    mock_conn.fetch = AsyncMock(
        side_effect=[
            [{"id": 1, "gene": "HTRA1", "gwas_trait": None, "references": None}],
            [],  # gene_references
            [],  # gene_gwas_traits
            [],  # gene_monogenic_links
        ]
    )
    _mock_connection(mocker, mock_conn)

    assert await _read_genes_with_lists() == [
        {"gene": "HTRA1", "gwas_trait": None, "references": None}
    ]


async def test_join_rows_attach_to_their_gene_in_ordinal_order(mocker) -> None:
    mock_conn = AsyncMock()
    mock_conn.fetch = AsyncMock(
        side_effect=[
            [{"id": 1, "gene": "HTRA1", "references": None}],
            [
                {"gene_id": 1, "pmid": "33773636"},
                {"gene_id": 1, "pmid": "33773637"},
            ],
            [],
            [],
        ]
    )
    _mock_connection(mocker, mock_conn)

    assert await _read_genes_with_lists() == [
        {"gene": "HTRA1", "references": ["33773636", "33773637"]}
    ]
```

`_mock_connection` (`test_export_main.py:24`) yields one connection for the
whole `async with` block, so the four `fetch` calls are one `side_effect` list
in `_GENE_LIST_SOURCES` order. `json` and `Path` are already imported there;
`clean_column_name`, `to_camel`, `_RENAMES` and `_GENE_COLUMNS` are not.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `uv run pytest tests/pipeline/ -v` Expected: PASS — but only after Step 4's
rewrites. Expect the five raw-string cases to fail first if Step 4 was skipped;
that is the signal, not a surprise.

- [ ] **Step 9: Prove the JSON is byte-identical — the real gate**

Backfill the throwaway database from Task 1, then regenerate:

```bash
uv run scripts/backfill_gene_lists.py
deno task data
git diff --stat data/
```

Expected: **empty diff.** A non-empty `data/table1.json` diff means the join
tables disagree with the old parsing — fix the backfill or the read order, never
the committed JSON. Two failure shapes are worth recognising on sight: a
whole-file diff with keys in a new order is `_GENE_COLUMNS`; a handful of rows
where an array became a bare string is a placeholder that was not selected.

Run the byte-exact suite explicitly too:

```bash
uv run pytest tests/pipeline/export/test_writer.py -v
deno test -A tests/data_contract_test.ts
```

- [ ] **Step 10: Commit**

```bash
git add pipeline/export/ tests/pipeline/export/
git commit -m "Read the gene lists from their join tables"
```

---

### Task 4: Switch the ingest to write the join tables

**Files:**

- Modify: `pipeline/data_merger.py:80-115` (`_build_combined_gene_data`)
- Modify: `pipeline/database.py:146-401` (`merge_genes_transactional`)
- Modify: `tests/pipeline/test_data_merger.py`,
  `tests/pipeline/test_database.py`

**Interfaces:**

- Consumes: the tables from Task 1.
- Produces: `_build_combined_gene_data` returns `gwas_trait` and `references` as
  `list[str]` rather than joined strings. `merge_genes_transactional` appends
  those lists into `gene_references` / `gene_gwas_traits` inside the existing
  transaction, **and keeps writing the legacy TEXT columns** by joining the same
  lists at the SQL boundary.

**Why this task exists.** `merge_genes_transactional` is the other writer of
these columns, and nothing in Tasks 1–3 touched it. Its union-dedup SQL
(`database.py:188-212`, `:254-279`, `:311-331`, `:362-381`) reads and rewrites
the delimited text on every merge, so migration 006 turns every ingest run into
an error. The byte-exact gate cannot see this: it regenerates JSON from the
database, and the merge is upstream of the database, not of the JSON.

**Dual-write is deliberate.** The legacy columns keep being written here so that
Tasks 1–4 stay revertable as a unit — the TEXT columns remain current, so
reverting Task 3 restores a working export with no data loss. Task 5 deletes
that half. The lists are the single source: the joined strings are derived from
them in the parameter tuples, never maintained separately.

`gene_monogenic_links` gets no writer — see Out of Scope.

- [ ] **Step 1: Write the failing tests**

In `tests/pipeline/test_data_merger.py`, replace `test_gwas_trait_joined`
(`:104`) and adjust `test_empty_defaults` (`:125`):

```python
def test_gwas_trait_is_a_deduped_list(self, make_gene_entry):
    """The join table takes one row per trait, so the merge stops joining."""
    data = _build_combined_gene_data([
        make_gene_entry(gwas_trait=["WMH", "SVS"]),
        make_gene_entry(gwas_trait=["SVS", "lacunes"]),
    ])
    assert data["gwas_trait"] == ["WMH", "SVS", "lacunes"]
    assert data["references"] == []
```

In `tests/pipeline/test_database.py`, beside the existing SQL-shape cases
(`:722-745`):

```python
async def test_the_append_is_idempotent_and_continues_the_ordinals(self, mocker):
    """Both properties are the delimited columns' invariants, restated:
    'append iff not already present' becomes NOT EXISTS, and
    string_agg's first-occurrence order becomes MAX(ordinal) + 1."""
    sql = _append_gene_list_sql("gene_references", "pmid")
    assert "NOT EXISTS" in sql
    assert "MAX(t.ordinal) + 1" in sql
    assert "ROW_NUMBER() OVER (ORDER BY incoming.first_ord)" in sql


async def test_both_join_tables_are_appended_after_the_row_upsert(self, mocker):
    ...  # assert executemany was awaited for gene_references and
         # gene_gwas_traits, after the genes INSERT/UPDATE, on the same conn
```

- [ ] **Step 2: Run them to verify they fail**

Run:
`uv run pytest tests/pipeline/test_data_merger.py tests/pipeline/test_database.py -v`
Expected: FAIL — `ImportError` on `_append_gene_list_sql`, and the joined-string
assertion.

- [ ] **Step 3: Return lists from the merger**

In `pipeline/data_merger.py:100,108`:

```python
"gwas_trait": dedupe_list(all_gwas),
...
"references": dedupe_list(all_pmids),
```

`link_to_monogenetic_disease` stays `""` (`:105`) — its column still exists, and
the extraction has never populated it. Task 5 removes the field with the column.

- [ ] **Step 4: Add the append statement**

In `pipeline/database.py`, above `merge_genes_transactional`:

```python
# (join table, value column, the key _build_combined_gene_data supplies).
# gene_monogenic_links is absent by design: the extraction never produces
# OMIM links, so nothing here would write it.
_GENE_LIST_APPENDS: Final[tuple[tuple[str, str, str], ...]] = (
    ("gene_references", "pmid", "references"),
    ("gene_gwas_traits", "trait", "gwas_trait"),
)


def _append_gene_list_sql(table: str, column: str) -> str:
    """Append a gene's new list values, preserving order and deduping.

    Three properties, each one an invariant the delimited columns carried
    and tests/pipeline/test_database.py now pins here instead:

    * **Idempotent.** NOT EXISTS drops any value the gene already has, so
      re-running a batch writes nothing. This is the string invariant
      "append iff the new PMID isn't already present" (database.py:165-169),
      restated as a row.
    * **Ordinals continue.** MAX(ordinal) + 1 reads the pre-statement
      snapshot -- an INSERT ... SELECT never sees its own rows -- so every
      row of one batch offsets from the same base and ROW_NUMBER keeps them
      contiguous.
    * **First occurrence wins.** GROUP BY with MIN(ord) collapses duplicates
      inside the incoming array onto their earliest position, which is what
      string_agg(val, ', ' ORDER BY first_ord) did.

    Matching on UPPER(gene) is the UPDATE's rule (database.py:385), so the
    insert path's ON CONFLICT and the update path land on the same row.
    Both names come from _GENE_LIST_APPENDS, never from input.
    """
    return f"""
        INSERT INTO {table} (gene_id, ordinal, {column})
        SELECT
            g.id,
            COALESCE(
                (SELECT MAX(t.ordinal) + 1 FROM {table} t WHERE t.gene_id = g.id),
                0
            ) + ROW_NUMBER() OVER (ORDER BY incoming.first_ord) - 1,
            incoming.val
        FROM genes g
        CROSS JOIN (
            SELECT btrim(value) AS val, MIN(ord) AS first_ord
            FROM unnest($2::text[]) WITH ORDINALITY AS raw(value, ord)
            WHERE btrim(value) <> ''
            GROUP BY btrim(value)
        ) incoming
        WHERE UPPER(g.gene) = UPPER($1)
          AND NOT EXISTS (
              SELECT 1 FROM {table} existing
              WHERE existing.gene_id = g.id
                AND existing.{column} = incoming.val
          )
    """  # noqa: S608
```

An empty `$2` makes the CROSS JOIN empty, so a gene with no new values is a
no-op rather than a special case.

**This statement was run against `postgres:18.6` on 2026-08-31, while writing
this plan.** `['33773636', '32358547', '33773636', '  ']` wrote two rows at
ordinals 0 and 1 — the in-array duplicate collapsed onto its first position and
the blank was dropped; the identical batch re-run wrote **0**;
`['33773637', '33773636']` added only `33773637`, at ordinal 2; an empty array
and an unknown gene symbol each wrote 0; and `DELETE FROM genes` took the join
rows with it through `ON DELETE CASCADE`. So the syntax is known good and the
three invariants above hold — Step 7 re-runs it in context rather than
discovering it.

- [ ] **Step 5: Call it, and derive the legacy strings**

Inside the `async with Database.connection() as conn, conn.transaction():`
block, after both existing `executemany` calls (`database.py:171-399`):

```python
# Appended after both statements above, so a gene inserted in this
# same transaction already has its id.
for table, column, key in _GENE_LIST_APPENDS:
    await conn.executemany(
        _append_gene_list_sql(table, column),
        [
            (g.get("gene"), g.get(key) or [])
            for g in (*to_insert, *to_update)
        ],
    )
```

And in the two parameter tuples (`database.py:284-300` and `:386-398`), join the
lists for the columns that still exist:

```python
# The last writers of the delimited columns. Both
# joins go with migration 006; the lists above are
# the source, so the two representations cannot
# drift apart in the meantime.
", ".join(g.get("gwas_trait") or []),
...
"; ".join(g.get("references") or []),
```

- [ ] **Step 6: Run the tests**

Run: `uv run pytest tests/pipeline/ -v` Expected: PASS.

- [ ] **Step 7: Prove the SQL runs**

The shape tests mock the connection, so they cannot catch a syntax or type
error. Run the statement against the Task 1 container:

```bash
docker exec -i csvd-migrate-check psql -U csvd_user -d csvd_check <<'SQL'
INSERT INTO genes (gene) VALUES ('HTRA1') ON CONFLICT (gene) DO NOTHING;
SQL
```

Then exercise the append twice with the same array and once with an overlapping
one, using `_append_gene_list_sql`'s text, and assert:

- first run writes ordinals `0, 1`;
- the identical second run writes **zero** rows;
- an array of `{33773637, 33773636}` adds only `33773637` at ordinal `2`.

```bash
docker exec -i csvd-migrate-check psql -U csvd_user -d csvd_check \
  -c "SELECT ordinal, pmid FROM gene_references ORDER BY ordinal"
```

Expected: `0|33773636`, `1|32358547`, `2|33773637`. Then clean up the row:
`DELETE FROM genes WHERE gene = 'HTRA1'` — the `ON DELETE CASCADE` takes the
join rows with it, which is itself worth seeing once.

- [ ] **Step 8: Commit**

```bash
git add pipeline/database.py pipeline/data_merger.py tests/pipeline/
git commit -m "Write the gene lists to their join tables on merge"
```

---

### Task 5: Drop the source columns

**Files:**

- Create: `pipeline/alembic/versions/006_drop_gene_list_columns.py`
- Modify: `pipeline/database.py` (delete the delimited-column SQL)
- Modify: `pipeline/data_merger.py:105` (drop the always-empty field)
- Modify: `tests/pipeline/test_alembic_migrations.py`,
  `tests/pipeline/test_database.py`, `tests/pipeline/test_data_merger.py`

**Interfaces:**

- Consumes: a verified-equivalent export from Task 3 and a verified ingest from
  Task 4.
- Produces: `genes` without `references`, `gwas_trait`,
  `link_to_monogenetic_disease`, and a merge that no longer mentions them.

**Do not start this task until Task 3's `git diff data/` was empty and Task 4's
Step 7 passed.** Once the columns are gone the backfill has no source, and
`downgrade` restores the columns but not their contents.

- [ ] **Step 1: Add the test case**

```python
("006_drop_gene_list_columns.py", "DROP COLUMN", "ADD COLUMN"),
```

- [ ] **Step 2: Run it to verify it fails**

Run: `uv run pytest tests/pipeline/test_alembic_migrations.py -v` Expected: FAIL
— file does not exist.

- [ ] **Step 3: Write the migration**

```python
"""Drop the genes list-columns now that the join tables carry them.

005 added gene_references, gene_gwas_traits and gene_monogenic_links; the
backfill populated them, the export was verified to regenerate
data/table1.json byte-identically from them, and merge_genes_transactional
was switched to write them. These three columns have no readers and no
writers left.

`downgrade` restores the columns but NOT their contents: the delimited text
cannot be reconstructed from the join tables without re-deciding the
separator and spacing that produced the original bytes. Re-running the
export is the supported way back.

Revision ID: 006
Revises: 005
Create Date: 2026-08-31
"""

from collections.abc import Sequence

from alembic import op

revision: str = "006"
down_revision: str | None = "005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute('ALTER TABLE genes DROP COLUMN IF EXISTS "references"')
    op.execute("ALTER TABLE genes DROP COLUMN IF EXISTS gwas_trait")
    op.execute(
        "ALTER TABLE genes DROP COLUMN IF EXISTS link_to_monogenetic_disease"
    )


def downgrade() -> None:
    op.execute('ALTER TABLE genes ADD COLUMN IF NOT EXISTS "references" TEXT')
    op.execute("ALTER TABLE genes ADD COLUMN IF NOT EXISTS gwas_trait TEXT")
    op.execute(
        "ALTER TABLE genes ADD COLUMN IF NOT EXISTS "
        "link_to_monogenetic_disease TEXT"
    )
```

`"references"` stays double-quoted: it is a reserved word, and
`001_baseline_schema.py:38` quotes it for the same reason.

- [ ] **Step 4: Delete the delimited-column SQL from the merge**

This is the fiddliest edit in the plan, because the placeholders renumber.

In the INSERT (`database.py:174-301`):

- remove `gwas_trait`, `link_to_monogenetic_disease` and `"references"` from the
  column list (`:174-179`), leaving eight columns and `$1..$8` rather than
  `$1..$11`;
- delete the `gwas_trait` union block (`:188-212`) and the `"references"` union
  block (`:254-279`) from the `ON CONFLICT DO UPDATE SET` clause;
- delete the three matching entries from the parameter tuple (`:284-300`),
  including the two `", ".join(...)` / `"; ".join(...)` derivations Task 4
  added.

In the UPDATE (`database.py:303-399`):

- delete the `gwas_trait` union block (`:311-331`) and the `"references"` union
  block (`:362-381`);
- the remaining placeholders renumber from
  `$1 protein, $2 gwas_trait,
  $3 mendelian_randomization, $4 evidence, $5 references, $6 source_quote,
  $7 gene`
  to
  `$1 protein, $2 mendelian_randomization, $3 evidence,
  $4 source_quote, $5 gene`,
  and the parameter tuple (`:387-397`) loses its two entries to match.

Also delete the `"references" dedup invariant` comment (`:165-169`) — it
describes a representation that no longer exists; `_append_gene_list_sql`'s
docstring carries the invariant now — and drop
`"link_to_monogenetic_disease": ""` from `_build_combined_gene_data`
(`data_merger.py:105`).

The `evidence_from_other_omics_studies` union blocks stay untouched. That column
is deliberately not normalized.

- [ ] **Step 5: Run the tests**

Run: `uv run pytest tests/pipeline/ -v` Expected: PASS. A placeholder left
misnumbered shows up here as an asyncpg argument-count error, not as a silent
wrong write.

- [ ] **Step 6: Regenerate once more and confirm nothing moved**

```bash
uv run alembic -c pipeline/alembic.ini upgrade head
deno task data
git diff --stat data/
```

Expected: empty diff. This is a real assertion rather than a formality —
`_GENE_COLUMNS` and its Task 3 Step 7 test are the only things making it true,
since `SELECT *` would have reordered every row here.

Then re-run Task 4 Step 7's live check against the migrated container, so the
merge is proven against the final schema, and stop the container:
`docker stop csvd-migrate-check`.

- [ ] **Step 7: Commit**

```bash
git add pipeline/ tests/pipeline/
git commit -m "Drop the genes list-columns now the join tables carry them"
```

---

### Task 6: Make `mendelian_randomization` a boolean

Independent of Tasks 1–5 in content, not in numbering: taken **after** them the
migration is `007` revising `006`, as written below; taken **first** it is `005`
revising `004`, and the placeholder numbers in Step 5 are the current ones
rather than Task 5's. Pick one and renumber consistently — Alembic will not.

**Files:**

- Create: `pipeline/alembic/versions/007_mendelian_randomization_boolean.py`
- Modify: `pipeline/export/tables.py` (`clean_gene_row`),
  `pipeline/database.py`, `pipeline/data_merger.py:101-103`
- Modify: `tests/pipeline/export/test_tables.py`,
  `tests/pipeline/test_database.py`, `tests/pipeline/test_data_merger.py`,
  `tests/pipeline/test_alembic_migrations.py`

**Interfaces:**

- Consumes: nothing from Tasks 1–5.
- Produces: `genes.mendelian_randomization` as `BOOLEAN`. The wire field stays
  `mendelianRandomization: string` with values `"Yes"` / `"No"` — **the JSON
  does not change**, so `lib/constants.ts`'s binary filter is untouched.

Today the column is `varchar(10)` and `normalize_yes_no`
(`pipeline/export/text.py:111-118`) folds `Y`, `N`, `Yes`, `No` — four spellings
for two states, which is the column type doing no work. The merge is where that
costs something: `database.py:214-219` and `:332-336` test
`mendelian_randomization = 'Y'`, which a curated `'Yes'` row does not match, so
the sticky-OR silently does not stick for those rows. The migration folds both
spellings to `TRUE` and the bug goes with the type.

- [ ] **Step 1: Write the failing test**

```python
def test_clean_gene_row_renders_boolean_mr_as_yes_no() -> None:
    assert clean_gene_row({"gene": "X", "mendelian_randomization": True})[
        "Mendelian Randomization"
    ] == "Yes"
    assert clean_gene_row({"gene": "X", "mendelian_randomization": False})[
        "Mendelian Randomization"
    ] == "No"
    assert clean_gene_row({"gene": "X", "mendelian_randomization": None})[
        "Mendelian Randomization"
    ] == "No"
```

NULL renders `"No"`, matching today's behaviour: `clean_gene_row`
(`tables.py:148-151`) fills a missing value with `"N"` before `normalize_yes_no`
sees it, because missing and textual-NA both mean no MR support in the source
schema.

The revision needs its parametrize case too, like every other migration — this
one keys on the type rather than on `ADD`/`DROP`:

```python
("007_mendelian_randomization_boolean.py", "TYPE BOOLEAN", "VARCHAR(10)"),
```

- [ ] **Step 2: Run it to verify it fails**

Run:
`uv run pytest tests/pipeline/export/test_tables.py tests/pipeline/test_alembic_migrations.py -k "boolean_mr or 007" -v`
Expected: FAIL — `normalize_yes_no` calls `.strip()` on a bool, and the revision
file does not exist.

- [ ] **Step 3: Write the migration**

```python
"""Store Mendelian randomization as a boolean.

The column is varchar(10) holding Y, N, Yes and No -- four spellings for two
states, folded by normalize_yes_no on the way out. The wire format keeps
"Yes"/"No" strings, so data/table1.json and the binary filter in
lib/constants.ts are unaffected.

NULL is preserved as NULL; the export renders it "No", as it already does
for a missing cell.

Revision ID: 007
Revises: 006
Create Date: 2026-08-31
"""

from collections.abc import Sequence

from alembic import op

revision: str = "007"
down_revision: str | None = "006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE genes
        ALTER COLUMN mendelian_randomization TYPE BOOLEAN
        USING CASE
            WHEN UPPER(TRIM(mendelian_randomization)) IN ('Y', 'YES') THEN TRUE
            WHEN UPPER(TRIM(mendelian_randomization)) IN ('N', 'NO') THEN FALSE
            ELSE NULL
        END
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE genes
        ALTER COLUMN mendelian_randomization TYPE VARCHAR(10)
        USING CASE
            WHEN mendelian_randomization THEN 'Yes'
            WHEN NOT mendelian_randomization THEN 'No'
            ELSE NULL
        END
    """)
```

- [ ] **Step 4: Render the boolean in the export**

In `pipeline/export/tables.py`, replace the fill at `tables.py:148-151`:

```python
# Missing and false both mean no MR support in the source schema.
values["mendelian_randomization"] = bool(
    values.get("mendelian_randomization")
)
```

and the `normalize_yes_no` call at `tables.py:185`:

```python
out["Mendelian Randomization"] = (
    "Yes" if out["Mendelian Randomization"] else "No"
)
```

Keep `normalize_yes_no` in `text.py` — `clean_trial_row` still uses it for
`genetic_evidence` (`tables.py:229`).

- [ ] **Step 5: Fix the merge, which also stores this column**

`data_merger.py:101-103` builds the string `"Y"` or `""`. `""` is not a castable
boolean, so asyncpg rejects it before PostgreSQL sees it:

```python
"mendelian_randomization": any(
    entry.mendelian_randomization for entry in entries
),
```

Then replace the two `CASE` expressions with the boolean OR they were emulating
— `database.py:214-219`:

```sql
mendelian_randomization =
    COALESCE(genes.mendelian_randomization, FALSE)
    OR COALESCE(EXCLUDED.mendelian_randomization, FALSE),
```

and `database.py:332-336`, where `$3` is the current placeholder and `$2` the
one Task 5 leaves behind:

```sql
mendelian_randomization =
    COALESCE(mendelian_randomization, FALSE)
    OR COALESCE($3::boolean, FALSE),
```

One behaviour change worth stating: a row that was NULL becomes `FALSE` on its
first merge rather than `''`. Both render `"No"`, so the wire format is
unchanged. Update `test_mendelian_randomization_yes` / `_no`
(`tests/pipeline/test_data_merger.py:110-119`) to assert booleans.

- [ ] **Step 6: Run the tests and the byte-exact gate**

```bash
uv run pytest tests/pipeline/ -v
uv run alembic -c pipeline/alembic.ini upgrade head
deno task data
git diff --stat data/
```

Expected: PASS and an empty `data/` diff.

- [ ] **Step 7: Commit**

```bash
git add pipeline/ tests/
git commit -m "Store Mendelian randomization as a boolean"
```

---

## Verification

End to end, after Task 5 (and Task 6 if taken):

```bash
uv run ruff check .
uv run ty check
uv run pytest --cov=pipeline --cov=pipeline/alembic --cov-branch
uv run pytest tests/scripts          # not in testpaths; CI never runs it
deno task check
deno test -A tests/data_contract_test.ts
```

Then the one that actually proves the export half:

```bash
deno task data
git diff --stat data/
```

**An empty `data/` diff is the acceptance criterion for the export.** The wire
format was never supposed to change; if it did, the storage change was not
faithful. Do not run `deno fmt data/` to close a diff — the writer's output is
already fmt-clean, so a formatting difference is a writer bug.

**The ingest half has no such oracle, so it is verified by running it.** Call
`merge_genes_transactional` directly against the throwaway container rather than
driving `pipeline/main.py --pubmed --days-back 7` — the real entry point spends
Anthropic tokens on extraction to reach the same SQL, and `pipeline/CLAUDE.md`'s
record of the one live run shows how easily a short window returns an empty
batch, which is exactly the case that proves nothing:

```bash
DB_HOST=localhost DB_PORT=55432 DB_NAME=csvd_check \
DB_USER=csvd_user DB_PASSWORD=ephemeral \
uv run python -c "
import asyncio
from pipeline.database import merge_genes_transactional

batch = [{
    'protein': 'HTRA1', 'gene': 'HTRA1', 'chromosomal_location': '',
    'gwas_trait': ['WMH', 'SVS'], 'mendelian_randomization': False,
    'evidence_from_other_omics_studies': '', 'brain_cell_types': '',
    'affected_pathway': '', 'references': ['33773636', '32358547'],
    'source_quote': None,
}]
print(asyncio.run(merge_genes_transactional(batch, [])))
print(asyncio.run(merge_genes_transactional([], batch)))
"
```

Two fields change shape with the tasks: add `'link_to_monogenetic_disease': ''`
if Task 5 has not landed, and use `''` rather than `False` for
`mendelian_randomization` if Task 6 has not. Then read the join tables back:

```bash
docker exec -i csvd-migrate-check psql -U csvd_user -d csvd_check -c \
  "SELECT g.gene, r.ordinal, r.pmid FROM gene_references r
     JOIN genes g ON g.id = r.gene_id ORDER BY g.gene, r.ordinal"
```

Expected: ordinals contiguous from 0 per gene, and the second call above — the
same batch through the update path — adding no rows at all.

Finally, re-run the drift check from commit `f5f9380` to confirm the live schema
matches the new migration head — the same method, against a throwaway container,
comparing a `pgschema dump` of `alembic upgrade head` from empty with one of the
live database.

## Rollback

Tasks 1–4 are reversible with `alembic downgrade` and a `git revert`; the source
columns still hold their data throughout, and Task 4 keeps them current
precisely so that reverting Task 3 restores a working export. **Task 5 is the
point of no return** — after it, the delimited text exists only in git history
and in `data/table1.json`. Do not run it until Task 3's byte-exact gate has
passed against the live database and Task 4's append has been exercised against
a real one.
