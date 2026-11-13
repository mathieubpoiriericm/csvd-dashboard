---
name: update-from-upstream
description: Use when pulling upstream changes into a disease fork - the merge, the one resolution per location (data/, disease/, the csvd/ trees, the README's first line, fly.toml's app and region and its session volume, docs/screenshots/, and the fork's own edits outside disease/ - the recall cassettes, GOLD_ONLY, _ADMITTED_UNASKED, the leak sentinels, e2e/package.json), the schema diff for new manifest keys, and the gates afterwards.
---

# Updating a disease fork from upstream

The fork was set up by the `new-disease` skill, with the upstream repository
as the `upstream` remote. Upstream keeps shipping code, tests and its own
cSVD data and screenshots; the fork keeps its own `disease/`, its own `data/`,
its own `docs/screenshots/` and none of the `csvd/` test trees. The
`new-disease` skill also had the fork edit five files upstream goes on
changing — the recall cassettes, `lib/gold_only.ts`,
`tests/pipeline/test_prompt_vocabulary.py`, `server/protected_data_build.ts`
and `e2e/package.json` — and a merge can meet each of those edits again.
Everything outside the table below merges clean by construction — that is
what the disease seam is for — so a conflict anywhere else is a bug to report
upstream, not something to resolve locally.

## The merge

```bash
git fetch upstream
OLD_UPSTREAM=$(git merge-base HEAD upstream/main)   # keep this for the schema diff below
git merge upstream/main
```

Then one resolution per location, in this order.

## One resolution per location

| Location                                                                   | Resolution                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data/*.json`                                                              | **Ours.** `git checkout --ours -- data && git add data`. Then regenerate: `deno task data && deno task geocode` against the fork's database, or `deno task data:empty` if the fork has not run the pipeline yet. Never keep upstream's rows: they are cSVD. That includes `data/review_round.json`, upstream's review round: a fork's export (with `GOLD_ONLY` off) or `deno task data:empty` writes it `null`. |
| `disease/*`                                                                | **Ours**, then the schema diff below for keys upstream added.                                                                                                                                                                                |
| `tests/csvd/`, `e2e/tests/csvd/`, `tests/pipeline/csvd/`, `tests/scripts/csvd/` | Upstream's new files there arrive as "deleted by us" (or as plain additions when the merge is clean). Remove them again: `git rm -r -q -f --ignore-unmatch tests/csvd e2e/tests/csvd tests/pipeline/csvd tests/scripts/csvd` -- `-f` because a file the merge staged is one `git rm` otherwise refuses to drop. |
| `README.md`                                                                | Generic upstream, so it normally merges clean. If the fork retitled it, the H1 is **ours**; everything below it is upstream's.                                                                                                                 |
| `disease/README.md`                                                        | **Ours**, entirely; upstream's is the cSVD page.                                                                                                                                                                                             |
| `fly.toml`                                                                 | **Ours** for `app` and `primary_region`, which name the fork's own Fly app; **upstream's** for every other line, with one choice. Upstream's `[mounts]` and `ADAPT_SESSIONS_DIR` keep the adapt guide's saved sessions on a volume: a fork that takes them runs `fly volumes create persistent_session_storage --region <region> --size 1` before the merge reaches its `main`, since every push there deploys and Fly's reference says the mounted volume "must exist in _some_ region for the application to deploy". A fork that stays without sessions deletes both instead, and its guide works without Save session. The `deploy` skill has the rest. |
| `lib/gold_only.ts`                                                         | **`GOLD_ONLY = false`**, whatever upstream's line says, **and checked after a clean merge too**: a fork that branched while the switch was off never edited the line, so upstream's `true` arrives without a conflict. Upstream switches it on while its own data is limited to its hand-curated tables; merged into a fork, it shows upstream's notice on the About page and makes `pipeline.main` refuse `--pubmed` and `--clinical-trials`. Every other line of the file is upstream's. |
| `tests/pipeline/cassettes/test_query_recall_gold/`                         | **Ours**: `git checkout --ours -- tests/pipeline/cassettes/test_query_recall_gold && git add tests/pipeline/cassettes/test_query_recall_gold`. The two files are named after the generic replay tests, so the fork's recordings and upstream's share their paths, and upstream records its own again whenever its data moves. A fork that has not recorded yet sees "deleted by us" instead: `git rm -r -q -f --ignore-unmatch tests/pipeline/cassettes/test_query_recall_gold`, or upstream's cSVD responses are replayed in place of the fork's recording. |
| `tests/pipeline/test_prompt_vocabulary.py`                                 | **`_ADMITTED_UNASKED = {}`**, whatever upstream's entries say: they explain cSVD trait keys, and a stale one fails `test_the_admitted_unasked_list_does_not_go_stale`. Every other line of the file is upstream's. |
| `server/protected_data_build.ts`                                           | **Ours** for the strings in `PROTECTED_DATA_SENTINELS`, once the fork has replaced them with its own data's; **upstream's** for every other line. |
| `e2e/package.json`                                                         | **Ours** for `name` and `description`; **upstream's** for every other line, its dependency versions included. |
| `docs/screenshots/`                                                        | **Recaptured**, whatever the merge left. Upstream's images are of the cSVD dashboard: they conflict where the fork recaptured its own, and arrive silently where it never did. After `data/` is regenerated, `deno task screenshots && git add docs/screenshots`; the task builds the merged code, so the images follow any page upstream changed too. It skips the review area, which a fork does not have: delete upstream's `review-*.webp` and their README rows if the merge brought them. |
| Anything else                                                              | Should not conflict. If it does, resolve nothing yet: note the file, finish the merge with the rest, and open an upstream issue naming the file and the two hunks — the seam has a leak there.                                                 |

## The schema diff

A new key in either schema is a key the fork's manifest now has to carry,
because `additionalProperties: false` is enforced on both sides and a
required key that is missing fails `tests/disease_manifest_test.ts` and
`tests/pipeline/test_disease.py`.

```bash
git diff "$OLD_UPSTREAM"..upstream/main -- disease/manifest.schema.json disease/pipeline.schema.json
```

For each added property: read what upstream's own `disease/manifest.json` or
`disease/pipeline.json` put there (`git show upstream/main:disease/manifest.json`)
to learn the shape, then write the fork's value — the researcher's, not a copy
of the cSVD one. A key added as optional (`type: ["string","null"]`, or not
in `required`) may be `null` until the researcher has a value. A removed key
is deleted from the fork's file, or the validators report it as unknown.

Two more upstream files can carry a change the fork has to mirror:

- `disease/prompt.md`'s **section ids**. If upstream's template in
  `pipeline/prompts.py` gained a `{{ slot }}`, the fork's `prompt.md` needs a
  `## <slot>` section or `render_prompt` refuses to start. `git diff
  "$OLD_UPSTREAM"..upstream/main -- disease/prompt.md | grep '^[+-]## '`
  lists them.
- `lib/*_encoding.json` and `disease/{timeline,phenogram}.json` are checked
  against each other by the encoding tests; a new registry fact (a phase, an
  evidence state) lives upstream in `lib/`, a new colour or family lives in
  the fork's `disease/` file, and the test names which is missing.

## Afterwards

Every gate, in the fork, before the merge commit is pushed:

```bash
deno task check && deno task test:coverage
uv run ruff check . && uv run ty check
uv run pytest --cov=pipeline --cov=pipeline/alembic --cov-branch --cov-report=term-missing:skip-covered
uv run pytest tests/scripts
npx --prefix e2e playwright test -c e2e/playwright.config.ts
```

If upstream added an Alembic migration, run
`cd pipeline && uv run alembic upgrade head` against the fork's database
before the next `deno task data`; the export reads the new column names. If
upstream changed the extraction prompt template, the fork's
`recall_baseline.json` is unaffected (it hashes the query, not the prompt),
but any extraction cassette the fork recorded is stale; the module docstring of
upstream's `tests/pipeline/csvd/test_extraction_golden.py` says how the golden
suite is re-recorded.

Commit the merge with the gates green, and say in the message which of the
locations above needed a hand.
