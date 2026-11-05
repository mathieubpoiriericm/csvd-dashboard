---
paths:
  - "pipeline/database.py"
  - "tests/pipeline/conftest.py"
  - "tests/scripts/conftest.py"
  - "tests/hermetic_env.py"
  - "tests/xdist_databases.py"
  - "tests/pipeline/test_database.py"
  - "tests/pipeline/test_database_integration.py"
  - "tests/pipeline/test_hermetic_environment.py"
  - "tests/pipeline/test_xdist_databases.py"
  - "tests/pipeline/test_reset_to_baseline_integration.py"
  - "tests/pipeline/test_restore_from_json_integration.py"
  - "tests/scripts/test_scripts_hermetic_environment.py"
---

# Database tests

**No test may reach the production database.** `_isolate_credentials` in
`tests/pipeline/conftest.py` clears the `DB_*` variables for exactly that
reason; see "Commands" in the root `CLAUDE.md`. **Clearing them was not enough,
twice over.** On 2026-11-03 test runs wrote four zero-filled `external_sync`
rows into production's `sync_runs` (ids 21-24), which the export publishes as
the newest refresh. `load_dotenv` fills any variable that is _absent_, and two
modules call it at import: `pipeline/main.py`, and `pipeline/export/main.py`,
which `_publish_export` imports lazily -- so in a partial run of
`test_main_orchestration.py` the first import happened _inside_ a test, refilled
the four credentials the fixture had just deleted, and the next dispatcher test
recorded its sync row in production. A full run never showed it, because the
export tests import the module at collection. The fixture now **empties**
`DB_HOST`, `DB_NAME`, `DB_USER` and `DB_PASSWORD` rather than deleting them
(empty reads as missing to `Database.get_pool`, and `database_env` sets the
throwaway database's values over them), and
`test_a_dotenv_load_inside_a_test_cannot_restore_the_credentials` loads `.env`
mid-test to prove it. Outside a test, both test trees' conftests call
`tests/hermetic_env.py`'s `shut_out_dotenv_database_credentials()` before
anything imports the pipeline: it sets `DB_HOST`, `DB_NAME`, `DB_USER` and
`DB_PASSWORD` to empty when they are unset, and `load_dotenv` never overrides a
set variable, so `.env`'s values cannot enter a test process at all. A value
exported in the shell is kept, and the hermetic test then fails loudly by
design: a production credential exported by hand is the same hazard.
`test_hermetic_environment.py` (and `test_scripts_hermetic_environment.py`) fail
if any of the four is set. `tests/scripts` had no isolation of its own before
this.

A test that wants real SQL asks for the `database_env` fixture, which brings up
**`dhi.io/postgres:18-alpine3.23`** as a container named `csvd-pg-pytest`,
migrated to head and destroyed with the session. No volume is mounted; nothing
survives the run.

It is **not** the glibc `dhi.io/postgres:18.6` the `regenerate-data` skill
documents, and that skill records why the two differ. What the glibc pin would
otherwise buy is kept by hand instead: no assertion in
`test_database_integration.py` depends on a text `ORDER BY`, and one added there
would compare musl's collation against production's glibc.

The runtime is **Apple's `container`**, not Docker: the fixture connects to the
container's own address on the `default` network rather than a published port,
so the production server on the host's 5432 is neither shadowed nor reachable.
The `regenerate-data` skill and `_container_address`'s docstring in
`conftest.py` carry the mechanism.

**`CSVD_TEST_DB_URL` comes first, and is what makes these tests run in CI.**
`container` is macOS-only and the `dhi.io` image needs a login CI does not have,
so on `ubuntu-latest` the whole file used to skip and every green PR merged with
no database having applied the migrations. On GitHub's runners the python job
runs a `postgres:18` service and points this variable at it; on the mini PC the
runner's own `.env` points it at a database of the runner's own on a native
PostgreSQL 18 (the `ci-runner` skill)
(`postgresql://user:password@host:port/database`); the fixture parses it into
the same `DB_*` settings, migrates that database to head and uses it. A
malformed URL **raises** rather than skips -- setting it is a statement of
intent to run these tests, and a skip would report that intent as coverage.
Point it only at a throwaway database: it is migrated and written to.

Without it the fixture falls back to the container, and **skips** only when the
`container` CLI, its system service or the image is unavailable too.

**Under pytest-xdist each worker gets a database of its own.** CI runs the
pipeline suites with `-n auto --maxprocesses=4`, and every worker is a pytest
session of its own, so the session-scoped fixture runs once per worker while
four files migrate and write the same tables -- sharing one database, two
workers collided on primary keys. With `PYTEST_XDIST_WORKER` set the fixture
creates `<db>_gw<n>` beside the database `CSVD_TEST_DB_URL` names (dropping a
crashed run's leftover first), migrates it and drops it when the worker
finishes; without the variable each worker runs its own container,
`csvd-pg-pytest-gw<n>`. **Both drops try a plain `DROP DATABASE` first**, which
stops an autovacuum worker on the database by itself, and fall back
to `WITH (FORCE)` only when a session is still connected, a crashed run's own.
Terminating an autovacuum worker, which carries no role, needs superuser or
`pg_signal_backend`, and the mini PC's `CREATEDB`-only role has neither: on
2026-11-05 autovacuum visiting a leftover failed runner-11's setup with
"permission denied to terminate process" (reproduced on PostgreSQL 18.6). Only
names carrying a worker suffix are ever dropped, and the role needs `CREATEDB`,
which CI's service superuser has. A run cut short leaves its `<db>_gw<n>` on a
server that outlives it -- CI's service does not -- and the next run with that
many workers drops and recreates it; `--maxprocesses=4` bounds them at four per
database, so they cannot pile up, and a wider local `-n` leaves its extra ones
until a run that wide comes again. A serial run is exactly what it was, and a
database test added later is isolated without a marker. It is not `xdist_group`:
on pytest 9.2.0, grouped tests spread across workers on xdist 3.6.1, 3.7.0 and
3.8.0 alike, reproduced on a minimal suite -- `tests/xdist_databases.py` carries
the reasoning.

`tests/pipeline/test_database_integration.py` is what uses it, and it covers
what a mocked connection cannot: that Alembic reaches a single head, that the
report survives the `JSON` column and `read_pipeline_run`'s re-validation, that
an ISO timestamp string becomes a real `timestamptz`, and **what the gene-merge
CTE computes** -- ordinals continuing off the pre-statement `MAX`, `btrim`
collapsing `"1 "` onto `"1"`, a re-run writing nothing, and `source_quote` and
`confidence` filling as one pair. `test_database.py` pins the spelling of those
clauses against the statement asyncpg is handed, which a mutation can satisfy
from inside an SQL comment; dropping `AND existing.pmid = incoming.val` from the
NOT EXISTS keeps all seven of its assertions passing and stops the merge
appending anything to a gene that already has one row. Every other database test
mocks `Database.connection`, which is how a duplicate `008` revision went
unnoticed -- `009_add_run_report` was applied to no database any test could see.
