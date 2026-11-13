---
name: regenerate-data
description: 'Use when regenerating data/*.json (deno task data, deno task geocode, or --export at the end of a pipeline run), the preview database and `deno task data:preview`, backing up or restoring the production database (from a dump, or from the committed data/*.json when no dump survives), working out which PostgreSQL is serving (the native Homebrew postgresql@18 that holds the data, versus the throwaway dhi.io/postgres:18-alpine3.23 container tests use), a server that brew services reports as started but that answers `FATAL: role "csvd_user" does not exist` (after a Homebrew reinstall, say), rebuilding a database from scratch, or drawing the print figures and cytobands (deno task figure, deno task cytobands).'
---

# Regenerating the data

Data regeneration (needs PostgreSQL reachable and `.env` populated — see
`.env.example`):

```bash
deno task data        # pipeline/export/main.py    → everything except the map
deno task geocode     # pipeline/export/geocode.py → data/geocoded_trials.json
deno task data:empty  # pipeline/export/empty.py   → the empty start, no database
```

`data:empty` is not a regeneration: it writes every file empty or `null` (the
OMIM table too, since it publishes only entries a published gene links to; the
cytobands untouched) so a fork, or the
`empty-data` CI job, starts from a state every suite passes on. Running it here
throws the committed data away in the working tree; `git checkout -- data`
brings it back.

**While `GOLD_ONLY` is true in `lib/gold_only.ts`, the database holds the
hand-curated gold tables alone** (written by `scripts/load_gold.py` from
`disease/gold/out/`, with each trial's population group read from
`disease/gold/trial_populations.csv`, a hand-kept file the loader refuses on a
group the manifest's `populations` do not list or a registry ID no gold trial
has). `deno task data` and `deno task geocode` publish them as they publish
anything else, and `--sync-external-data` and `--sync-annotations` still refresh
the lookups for their keys, but `pipeline.main` refuses `--pubmed` and
`--clinical-trials`, which would add rows the curators did not write, except
`--pubmed --preview` against the preview database (below). An ordinary export
while it is true leaves the committed `data/pipeline_run.json` alone and logs
"GOLD_ONLY is on; keeping the committed data/pipeline_run.json". The
way back, the pre-gold dump included, is the undo checklist in that file's doc
comment.

`--export` does the same work as `deno task data` at the end of a live pipeline
run (`uv run python -m pipeline.main --clinical-trials --export`), leaving the
files in the working tree. `deno task geocode` stays separate either way — it
calls out to clinicaltrials.gov — so a run that adds a trial needs it too, or
`tests/data_contract_test.ts` fails on the `nctIds` set.

## What `--export` does at the end of a run

`--export` does the work of `deno task data` at the end of a live run, so the
figures, the About page's date and the run widget track the database without a
second command. It **stops at the working tree** — the files are left modified
and nothing is committed, because the curated `genes` table is a scientific
judgement and the e2e fixtures pin exact row counts. It is refused with
`--local-pdfs` / `--pmids`, which publish no data; it is skipped after a
`--dry-run` or `--test-mode` preview, which writes nothing; and it runs even
when a pipeline **failed**, because `_record_failed_run` persists that failure
for the widget and not exporting is what would keep it invisible. An export
failure is folded into the exit code — the database having moved while the files
did not is the condition the flag exists to remove.

**A PubMed run refreshes the three lookup caches before that export**, for its
own new gene keys and PMIDs only (`_refresh_lookup_caches`, skipped when
`--sync-external-data` ran in the same invocation, which covers them anyway).
Nothing inside a run writes `ncbi_gene_info`, `uniprot_info` or
`pubmed_citations`, and `complete_lookup` turns a key it cannot find into a row
of nulls rather than failing — so `--export` used to publish every newly
inserted gene with a null NCBI uid, description and alias list and every newly
attached reference as `"(citation not available)"`. Each source fetches only its
own cache misses, so this costs what the run added and nothing more. It is
best-effort: a source that cannot be reached is logged as an error and the
export still runs, because the database has moved and leaving the files behind
it is worse. A run that _raised_ leaves no report to read those keys out of, so
whatever it merged before it died waits for the next `--sync-external-data`.

## The preview database

A preview run (`run-long-window` skill) writes to `<DB_NAME>_preview`, never to
production. The pipeline does not create it, and its role has neither `CREATEDB`
nor superuser on the Ubuntu server, so an admin creates it empty once, owned by
that role: `createdb -O <DB_USER> <DB_NAME>_preview` (on the server,
`sudo -u postgres createdb -O <DB_USER> <DB_NAME>_preview`). Fill it from
production, and the same way to recreate it for a re-run with `--clean`:

```bash
pg_dump -Fc <DB_NAME> > prod.dump
pg_restore --no-owner -d <DB_NAME>_preview prod.dump
pg_restore --clean --if-exists --no-owner -d <DB_NAME>_preview prod.dump  # re-run
```

Confirm the copy is the gold state: its gene count matches the committed
`data/table1.json` and `pubmed_refs` is empty.

`--preview --export` at the end of the run, and `deno task data:preview` for a
re-export without a new run, write two files and nothing else, and skip the
lookup-cache refresh: `data/pipeline_run.json`, the preview run's report, and
`data/review_round.json`, the round the review committee reads -- one change per
gene the run inserted or altered, diffed against the gold database. Gold is read
through a connection of its own inside a read-only transaction
(`gold_connection` in `pipeline/preview_run.py`), with the preview's
credentials, and is never written. The two files are staged together and
published in one atomic step, so a refusal publishes neither. The export refuses
when gold-only is off and when the newest run there is not a preview run, and
the round (`pipeline/export/review_round.py`) refuses in five more cases:

| `Preview export refused: …`                                         | What it means                                                                                   |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `the preview database holds N preview runs`                         | a retry or a second run was recorded there, so the report cannot say which rows are its own     |
| `the run report lists S of T accepted genes`                        | the report capped its accepted findings below their total, and a change would go unexplained    |
| `gold gene G is missing from the preview`                           | a gold row is absent from the preview, which a run never does (a run deletes nothing)           |
| `no finding explains the change to G`                               | a preview row differs from gold with no accepted finding behind it: something else wrote it     |
| `the preview's G lacks [...] of gold's F: a run never removes …`    | gold was curated after the preview was copied from it, on a row the run also touched            |

Each means the preview database is no longer gold plus one preview run. Do not
work around it: recreate the preview database from production as above
(`pg_restore --clean`), confirm it is the gold state, and run the preview again.
The first two are checked before gold is read. The restore below leaves a
preview run out: `ledger_from_logs` skips its report in `logs/json/` and
`logs/events.db`, and no `pipeline_runs` row is rebuilt from a
`data/pipeline_run.json` whose `runMode` is `preview`, so a restored production
database never treats the preview's papers as processed.

**A committed round goes stale when gold is curated, and then hides itself.**
A round is stale when a change's gold row (`before`) no longer equals the
committed `data/table1.json` row of its gene, that row is gone, or a new gene is
now in gold (`staleChanges` in `lib/review/stale.ts`). `currentReview` then
returns `null`, exactly as for a closed round: there is no Review control and
every `/review*` page is a 404, and the server logs one warning at start naming
how many changes no longer match. Nothing fails, so a gold fix ships without
waiting on a paid run. The ordinary export says so where the edit is made:
while gold-only is on, `deno task data` compares the rows it is about to
publish with the committed round (`stale_genes` in
`pipeline/export/review_round.py`, the same rule) and logs one warning naming
the first few genes; it writes nothing and never fails on it. The remedy is a
new round: rebuild the preview database from gold, make a new preview run, and
export it with `deno task data:preview`. Writing `null` to
`data/review_round.json` (`deno task data:empty` shows the form) is optional
housekeeping, not a fix: a stale round is already hidden.
No test fails on a stale round, and none may: a curation edit must not turn the
suite red. The generic `tests/review_round_run_test.ts` pins only the guard --
a stale round gives no review, a current open one under gold-only does.

## Two databases, and they are not interchangeable

**Production is a native Homebrew `postgresql@18` binary installation.
Containers are for testing only**, and they run under Apple's macOS-native
`container`, not Docker — Docker Desktop is not installed. The two servers are
never the same and never swap roles:

| | Production | Testing |
| --- | --- | --- |
| Where | Native Homebrew `postgresql@18` | Throwaway `container` PostgreSQL |
| Data directory | `/opt/homebrew/var/postgresql@18` | None — no volume, nothing survives |
| Reached by | The `.env` credentials on `localhost:5432` | The `database_env` fixture, at the container's own address |
| Lifetime | Permanent; holds the curated data | Created and destroyed per test session |

Production is managed with `brew services {start,stop,restart} postgresql@18`.
The formula is **keg-only, so its client tools are not on `PATH`** —
`pg_isready`, `psql` and `pg_dump` all read "command not found" until you add
them:

```bash
export PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"
```

**No test may touch the production database**, which is what
`_isolate_credentials` in `tests/pipeline/conftest.py` enforces by clearing
`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` and `DB_PASSWORD` outright. A test
wanting real SQL asks for the `database_env` fixture, which brings the
container up as `csvd-pg-pytest`, migrates it to head, and destroys it with the
session. It publishes no port: `container` gives the container **its own
address** on the `default` network, so it answers on 5432 there and cannot
shadow the production server on the host's 5432. See
`.claude/rules/pipeline/database-tests.md`.

**An empty container list says nothing about production.** `container list` and
`container volume list` describe only the testing shape; the native server is
invisible to them. Reading an empty `container list` as "the database is gone"
is a mistake this file exists to prevent — check the real one instead:

```bash
ps aux | grep '[p]ostgres'   # the native server names its data directory
pg_isready -h localhost -p 5432
```

**A server that answers can still be an empty cluster.** Reinstalling Homebrew
deletes `/opt/homebrew/var`, and the `postgresql@18` formula's post-install
runs `initdb` on the empty directory. `brew services` then reports `started`,
the server listens on 5432, and every connection fails with
`FATAL: role "csvd_user" does not exist`. That is not a configuration problem,
and no config change brings the data back. Check before touching any config:

```bash
stat -f '%SB' /opt/homebrew/var/postgresql@18/PG_VERSION   # when initdb ran
# /tmp is the formula's Unix socket, which connects as the macOS user --
# the one role a new cluster has.
psql -h /tmp -d postgres -XAtc "SELECT rolname FROM pg_roles WHERE rolname !~ '^pg_'"
```

A `PG_VERSION` born at the reinstall, and the macOS user as the only role, mean
the cluster is new: restore it from a dump, or from the committed JSON (both
below). A dump kept under `/opt/homebrew` goes with it, so keep dumps in
`~/Documents/csvd-dashboard-dumps/` -- outside `/opt/homebrew`, and outside
the repository, where `git clean` could reach them.

## The test container image

The runtime is **Apple's `container`** (`brew install container`;
`container system start` if `container system status` says otherwise). The
image is **`dhi.io/postgres:18.6`** — a
[Docker Hardened Image](https://docs.docker.com/dhi/), pulled from `dhi.io`
after `container registry login dhi.io`, not Docker Hub's `postgres:18.6`:

```bash
container image pull dhi.io/postgres:18.6
container run --detach --name csvd-pg \
  --env POSTGRES_USER=csvd_user --env POSTGRES_PASSWORD=… \
  --env POSTGRES_DB=csvd_dashboard \
  --volume csvd-pgdata:/var/lib/postgresql/18/data \
  dhi.io/postgres:18.6
cd pipeline && uv run alembic upgrade head
```

**Do not run that recipe on a machine that already has the native server.** It
stands up a second, empty database under the production database's own name and
user; point `.env` at its address and that reads as a wiped database. It is
here to document the image, and for a machine that has no native PostgreSQL at
all. The test fixture uses **`dhi.io/postgres:18-alpine3.23`**, not this image,
and none of these settings: its own container name, no volume, and the address
`container` assigns it. The last bullet below is why the two differ.

Four things about it are load-bearing:

- **`container` publishes nothing onto the host.** Each container gets its own
  address on the `default` network — `container list` prints it, and
  `container inspect <name>` reports it under `status.networks` in CIDR form.
  There is no `container port` subcommand. That is why the recipe above has no
  `-p` and why nothing it runs can collide with `localhost:5432`.

- **`PGDATA` is `/var/lib/postgresql/18/data`, not the official image's
  `/var/lib/postgresql/18/docker`.** A volume left at the old path leaves the
  container initializing an empty database beside it, which reads as a wiped
  schema rather than as a misplaced mount. It also runs as non-root (uid 70), so
  a _bind_ mount needs `chown 70:70`; the named volume above needs nothing.
- **Alpine is not the lighter alternative.** `postgres:18.6-alpine` measured
  _worse_ on the severities that matter — 3 critical and 27 high against
  `postgres:18.6`'s 2 and 23 — because the CVEs are in openssl and the vendored
  Go stdlib, not in the base OS the Alpine variant trims. The hardened image
  reports 0 critical, 0 high and 0 medium. Those numbers came from
  `docker scout quickview <image>`; re-measure rather than assuming, with
  whatever scanner is at hand — `container` ships none.
- **It is Debian and glibc**, collating `en_US.UTF-8` through the libc provider
  as the official image does. That is what makes it a drop-in for an existing
  data directory; a musl image would silently reorder every text index instead.
  That is why **this** recipe pins `18.6`, and it is a constraint about a
  mounted `PGDATA` rather than about the image as such. The pytest fixture
  mounts no volume and initdb's a fresh cluster every session, so it has no data
  directory to collate compatibly with, and it runs
  `dhi.io/postgres:18-alpine3.23` — the musl image, which is the one on disk.
  Both serve PostgreSQL 18.6. `PGDATA` there is
  `/var/lib/postgresql/18/data/pgdata`, one level deeper than here. Do not swap
  either image for the other: this recipe would reorder an existing index, and
  the fixture would skip every database test on an image that is not pulled.

## What can be rebuilt, and from where

"Regenerating the database" is two different jobs. The schema is fully
scripted; the data is not.

**Schema — one command.** Alembic reads `.env` itself
(`pipeline/alembic/env.py:22`), so nothing needs exporting first:

```bash
cd pipeline && uv run alembic upgrade head
```

Run it on an existing database too before the first `deno task data` after the
`disease-reuse` branch merges: migration 014 renames
`clinical_trials.svd_population` to `target_population`, and the export, the
merge and the clinical-trials sync all read the new name.

From nothing, that is preceded by creating the role and the database, as the
macOS user (the cluster's superuser). `csvd_user` is **not** a superuser and
needs not be: owning the database is enough for every migration, triggers and
the plpgsql function included. `-P` prompts for the password; type the `.env`
`DB_PASSWORD`. Both tools are keg-only like `psql`:

```bash
export PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"
createuser -P csvd_user
createdb -O csvd_user csvd_dashboard
```

Migrations 001-014 build the whole schema and **none of them seeds any data**.

**Data — scripted, but not all from the same place:**

| Table | Rebuilt by | Cost |
| --- | --- | --- |
| `genes` and its three list tables | `scripts.restore_from_json` from `table1.json` | free |
| `clinical_trials`, curated rows | `scripts.restore_from_json` from `table2.json` | free |
| `clinical_trials`, uncurated discoveries | `--clinical-trials` | free |
| `clinical_trials`, curated TERMINATED / WITHDRAWN rows | the pre-squash history (below), from a `table2.json` before `1299cd7` | free |
| NCBI / UniProt / PubMed caches | either (`--sync-external-data` refetches) | free |
| `gene_annotations` | `--sync-annotations` | free, ~30 min |
| `pubmed_refs` | `scripts.restore_from_json` from the run reports in `logs/`; older papers from the history (below) | free when a later run's skipped count names the gap; **paid re-extraction** otherwise |
| `pipeline_runs`, `sync_runs` | `scripts.restore_from_json`, latest run only; older runs from the history (below) | — |

**No migration seeds `genes`, and nothing upstream can refetch it**: those rows
are curator judgement that entered from the source spreadsheet, plus what the
pipeline has merged since. Outside the database it exists only in a dump and in
the published projection `data/table1.json`, which carries every column but
the id and timestamps — `source_quote` and `confidence` included. `_publishable`
in `pipeline/export/main.py` drops only `id`, `created_at` and `updated_at`.
The projection is only as current as the last export.

**A dump is the first backstop.** It is exact, and it also holds what the JSON
cannot: the ids, every `pipeline_runs` row, and `pubmed_refs` beyond the
surviving logs. That ledger's loss makes the next `--days-back` run re-extract
papers already paid for:

```bash
export PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"
DUMPS=~/Documents/csvd-dashboard-dumps
pg_dump -h localhost -U csvd_user -Fc csvd_dashboard > "$DUMPS/csvd_dashboard_$(date +%F).dump"
pg_restore -h localhost -U csvd_user -d csvd_dashboard --clean "$DUMPS/csvd_dashboard_<date>.dump"
```

Verify a dump rather than trusting it — restore into a scratch database and
compare, because matching row counts do not prove matching content:

```sql
SELECT md5(string_agg(t::text, '|' ORDER BY id)) FROM genes t;
```

### Restoring from the committed JSON

When no dump survives, `scripts/restore_from_json.py` rebuilds the tables in
the table above from `data/*.json` and `logs/`, into a database freshly
migrated to head:

```bash
uv run python -m scripts.restore_from_json           # builds and checks; writes nothing
uv run python -m scripts.restore_from_json --write
```

It refuses unless every `genes` and `clinical_trials` row, pushed back through
the export's own `clean_gene_row` / `clean_trial_row`, reproduces its committed
JSON row exactly. It also refuses to write into a database where any table it
fills holds a row, and writes in one transaction. Then check the result the way
the restore is tested: export into a scratch directory and compare bytes.
**Do not check with `deno task data`**: it writes over `data/`, the only other
copy.

```bash
OUT=$(mktemp -d)
uv run python -c "import asyncio, pathlib, sys; from pipeline.export.main import run_export; asyncio.run(run_export(pathlib.Path(sys.argv[1])))" "$OUT"
for f in "$OUT"/*.json; do cmp -s "$f" "data/${f##*/}" || echo "differs: ${f##*/}"; done
```

No output means every exported file matches. `gene_annotations.json` is not
among them: the export keeps the committed file until `--sync-annotations`
refills the table. The script's docstring lists what does not come back: the
annotations, the unpublished cache columns, the uncurated and the stopped
trials, papers older than the oldest report in `logs/`, and the ids. The
history below brings back the stopped trials, the older runs and the papers.

### Re-extracting under a new extraction method

The merge only adds, so a run under a new model or prompt cannot take the old
method's values back out of `genes`. When nothing the old method merged should
stand, `scripts/reset_to_baseline.py` puts the genes back to a curated
`table1.json` from before its first merge -- for this dataset
`a5915b4:data/table1.json` in the pre-squash history (below), the 63 curated
genes of 31 August 2026 -- empties `pubmed_refs` so the next window counts every
paper as new, and deletes the annotations of the genes it removes. Trials,
caches, the kept genes' annotations and the run history are left alone.

```bash
uv run python -m scripts.reset_to_baseline --baseline PATH            # check
uv run python -m scripts.reset_to_baseline --baseline PATH --write    # reset
```

It refuses unless every baseline row round-trips through the export, the live
table holds it plus additions only, and every gene it would remove carries the
quote and confidence of the extraction that inserted it, so no curation made
after the baseline can be thrown away unnoticed. `--write` runs that check again
inside its own transaction, under a lock on `genes` and its three list tables,
so nothing written after the dry check can be deleted unchecked; before that
lock it waits for any pipeline run between its gene merge and its
`pubmed_refs` write (`merge_window` in `pipeline/database.py`), which would
otherwise record its papers as processed after the reset had deleted their
genes. It prints its
target from the environment first. Take a dump, then rehearse on a throwaway
`container` copy: `pg_restore --no-owner` the dump into one, export **all five**
`DB_*` variables at its address (one left unset comes from `.env`, which names
production), and read the printed target before `--write`.

### What the pre-squash history still holds

The repository's history was squashed into one commit on 2026-09-24, but the
private repository's `refs/pull/*/head` still carry the 778 commits before it,
and with them every `data/*.json` committed since 2026-08-27. A plain clone
does not fetch those refs; a mirror does:

```bash
git clone --mirror https://github.com/mathieubpoiriericm/csvd-dashboard-private.git
git -C csvd-dashboard-private.git log --all --oneline -- data/table2.json
```

Three things came back from it on 2026-11-02, each written in one transaction
and checked by exporting before and after (all eleven files byte-identical):

- **A curated row an export filter withholds was published before the filter
  existed.** `1299cd7` stopped publishing TERMINATED and WITHDRAWN trials, so
  the nine curated ones were in no current file; `f1f589e:data/table2.json`
  still had them. Rename `svdPopulation`/`svdPopulationDetails` to today's keys
  (migration 014), invert with `trial_from_wire`, and fill only the five curator
  columns -- mechanism, genetic target and evidence, population and details --
  where `target_population IS NULL`: `--clinical-trials` rediscovers the rows
  themselves from the registry, curator columns empty. Check each against
  `clean_trial_row` before writing it.
- **Older run and refresh records are older file versions.** Each commit's
  `pipeline_run.json` with the same commit's `pipeline_status.json` goes through
  `_run_rows` as the newest one does; every committed `pipeline_syncs.json`
  entry is a `sync_runs` row. The readers take only the newest row (per mode),
  so these change no export.
- **The ledger's gap is named by a later run's skipped count.** The first
  logged run (event 4 in `logs/events.db`) skipped 18 PMIDs no surviving report
  lists. Its query and window -- the search module as it stood at the commit
  before that run, `pdat` from the run date minus `--days-back`, bounded by
  `edat` at the run date so later records cannot enter -- minus the restored
  ledger left exactly 18, and all 18 matched the newest run's query in its
  window. Only `SELECT pmid` reads `pubmed_refs`, so they went in with the
  unrecorded columns NULL.

`filter.ids` fetches every trial's locations in one request, so
`deno task geocode` no longer needs a cache or a rate limit.

`deno task figure` draws both figures for print — the trials timeline with
`scripts/timeline_figure.py` (pyCirclize) and the phenogram with
`scripts/phenogram_figure.py` (matplotlib). It runs through
`uv run --group figure`, which installs the group itself, and writes
`figures/{timeline,phenogram}.{svg,pdf,png}`, which are not committed.
`deno task cytobands` regenerates `data/cytobands_hg38.json` from UCSC; that
file _is_ committed, like every other `data/*.json`.

