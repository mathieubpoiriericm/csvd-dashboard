---
name: ci-runner
description: Use when CI jobs queue and never start, when moving CI between the home mini PC and GitHub's runners, when CI gets slower or the e2e suite turns flaky, when tuning test parallelism or adding a CI job, after upgrading @playwright/test, or when provisioning, re-registering or cleaning up the self-hosted runners - the CI_RUNNER variable and its fallback, the twelve-job layout and why its parallelism is moderate, nice, why the runners belong to the private repository alone, the per-runner E2E_PORT, and the machine's housekeeping.
---

# The self-hosted CI runners

The five test jobs in `.github/workflows/ci.yml` (`check`, `python`, `e2e`, and
the `empty-data` and `adapt-fork` matrices, twelve jobs in all) run on
`${{ vars.CI_RUNNER || 'ubuntu-latest' }}`. The private repository
(`mathieubpoiriericm/csvd-dashboard-private`) has set the repository variable
`CI_RUNNER=csvd-ci` since 3 November 2026, which sends them to twelve runners,
`ryzen-1` to `ryzen-12`, on a dedicated mini PC at home: Ubuntu Server 26.04 on
bare metal, a Ryzen 9 9955HX (16 cores, 32 threads) with 32 GB, reached from the
researcher's Mac as `ssh minipc` with key login only. The public repository and
every fork have no such variable and stay on `ubuntu-latest`. `container` and
`deploy` are hosted everywhere.

The same CI run, PR #65's (41720801102), took 8m01 on GitHub's two-core private
runners and 2m20 on the mini PC -- its first jobs there, on cold caches -- with
every suite's pass and skip counts identical. Before the `adapt-fork` split a
push took about ten minutes (run 41546971078, 2 November 2026). The layout below
took a pull request from 1m40s on six mini-PC runners to about a minute (62 s
and 66 s on PR #67, no flaky retries), and a push to `main` is live 1m42s after
it lands (the `deploy` skill has how).

## The layout, and why its parallelism is moderate

`empty-data` runs as three jobs, one per gate family (Deno, Python, e2e), and
`adapt-fork` as six, one per answer set and family
(`--shard=K/2
--only=<family>`). With `check`, `python` and `e2e` that is twelve
test jobs at once, one per runner, sharing 16 cores. On the mini PC:

| Setting                                        | Value                             |
| ---------------------------------------------- | --------------------------------- |
| `E2E_WORKERS` (read by `playwright.config.ts`) | 4 for every e2e suite             |
| pytest, pipeline suites                        | `-n auto --maxprocesses=4`        |
| pytest, `tests/scripts`                        | serial                            |
| every Deno and Python command                  | `nice -n 15` (the `$NICE` prefix) |
| `deno test`                                    | serial                            |

The worker count comes from `vars.CI_RUNNER` in `ci.yml`, so GitHub's runners
keep Playwright's 2 workers. `deno test --parallel` was in the design and is
out: test modules share one process under it, and the three auth test files,
which exist to prove the login gate reads the real environment, set and delete
`DASHBOARD_PASSPHRASE` and `DASHBOARD_SESSION_SECRET` -- a review reproduced
another file's test answering 503 four times in 41 runs, and Deno does not
retry. Excluding them from a parallel pass is no fix (a command-line `--ignore`
replaces deno.json's top-level `exclude`), and the Deno jobs finish well before
the e2e jobs anyway. `tests/deno_parallel_isolation_test.ts` fails if
`test:coverage` turns `--parallel` while such a file exists. What decided the
numbers, each configuration running the same twelve jobs (probe runs on 3
November 2026):

| Configuration                                     | Run        | Flaky retries |
| ------------------------------------------------- | ---------- | ------------- |
| six unsplit jobs, serial runners                  | 1m40s      | 0             |
| twelve jobs, every knob at maximum                | 1m36s      | 9             |
| twelve jobs, moderate                             | 1m22s      | 3             |
| moderate, Deno and Python under `nice -n 15`      | 60 s       | 2             |
| as above, 8 workers for `e2e`                     | 57 s       | 0             |
| **the layout** (4 workers everywhere), PR #67 × 2 | 62 s, 66 s | 0             |

- **Past about 16 busy threads every job slows.** The machine has 16 physical
  cores, and the second thread of each shares it: builds and test suites took
  twice their idle time with 25-30 threads busy. Parallelism also costs CPU --
  each pytest worker, Deno isolate and Chromium pays its own start-up -- so
  maximum settings did 2.5 times the work of the serial layout for the same
  tests.
- **A starved e2e suite flakes, and a flake costs 30 s.** The tests that failed
  their first attempt under maximum load -- a theme choice reaching another tab
  (`theme.spec.ts`), the genes table's empty state (`genes-table.spec.ts`), a
  tooltip closing (`csvd/tooltips.spec.ts`), two adapt-wizard steps
  (`adapt.spec.ts`) -- hit 30 s timeouts and expired `expect` waits. They are
  the candidates for hardening; at the settings above none flaked.
- **Priority beats width.** The e2e jobs are the critical path and Deno and
  Python finish early whatever happens, so running them under `nice` took 22 s
  off.
- **8 workers for `e2e` was one lucky run.** It measured 57 s with no retries on
  the probe branch, then retried two or three tests in each of PR #67's first
  two runs (trial filters, the map's Leaflet start-up, two performance-behaviour
  tests, all on 30 s test timeouts), and a retry costs more than the few seconds
  the workers save. At 4 it ran clean twice. If the suite turns flaky again, the
  next lever is less total load -- pytest `-n 2` -- not fewer browsers.
- **A Postgres service starting or stopping can abort another job's page load.**
  GitHub's runner gives each job with a service a Docker network of its own and
  deletes it when the job ends; the host's interfaces change, and Chromium in a
  concurrent e2e job aborts the navigation in flight with
  `net::ERR_NETWORK_CHANGED` at `localhost`. It appeared in 3 of the first 10
  runs of the split layout -- the Python families now finish while e2e is still
  running -- and never in the unsplit one. It fails fast and costs one quick
  retry, never a red run. Running PostgreSQL natively on the machine, with a
  database per job and worker, would remove it; that is a change to how the
  services work, not a setting.
- **About 55 s is the floor** at this volume of tests: six jobs finished within
  51-54 s of one another. Going lower means less work, not more parallelism.

## Switching

```sh
R=mathieubpoiriericm/csvd-dashboard-private
gh variable set CI_RUNNER --body csvd-ci -R $R   # to the mini PC
gh variable delete CI_RUNNER -R $R               # back to ubuntu-latest
gh api repos/$R/actions/runners \
  --jq '.runners[] | "\(.name) \(.status) busy=\(.busy)"'
```

**Jobs that sit in "Queued" are the machine being down.** A job waiting for a
self-hosted label with no runner online waits up to a day rather than failing.
Delete the variable, then re-run the failed or queued run; the jobs go to
GitHub's runners. Set it again once `actions/runners` lists the instances
`online`.

## What is non-obvious

- **The runners are registered to the private repository and nowhere else.** The
  public repository takes pull requests from forks, and a self-hosted runner
  runs whatever code a pull request's workflow names. A runner registered there
  would hand the machine to anyone who opens one. The variable is only the
  selector; the registration is the boundary.
- **No job may take a fixed host port.** On GitHub's runners every job has a VM
  of its own; here twelve share one. The postgres services publish on a free
  port, read back through `job.services.postgres.ports['5432']` into
  `CSVD_TEST_DB_URL` (in a step, because the `job` context is not available in a
  job's `env`). Each runner's `.env` sets `E2E_PORT` as 8100 plus its number
  (8101 to 8112), which `e2e/playwright.config.ts` serves the build on. A new
  job that serves on a port, or a fixed container name or image tag like the
  `container` job's, either follows suit or stays on `ubuntu-latest`.
- **After upgrading `@playwright/test`, re-run the provisioning script with the
  new `PLAYWRIGHT_VERSION`.** The workflow passes `--with-deps` only on GitHub's
  runners, because a self-hosted one has no sudo. A newer Chromium needing a
  package the machine lacks fails to launch, with Playwright's "Host system is
  missing dependencies" or a missing `.so`.
- **Every action in `ci.yml` runs on `node24`**, the newest runtime GitHub
  offers actions (`astral-sh/setup-uv` was the last on `node20`, until it moved
  to `v10.3.3` on 2026-11-03; it publishes exact versions only, so there is no
  `v10` tag to float on). A self-hosted runner too old for `node24` fails every
  job at its first action, so keep the runners updating themselves. The tests
  themselves run on Node 26, from `actions/setup-node`'s `node-version: 26`.
- **Caches live on the machine's disk.** `setup-uv` and `setup-node` cache
  through GitHub's service only on hosted runners; here uv, npm, Deno and
  Playwright keep their caches under `/home/runner`. `actions/checkout` still
  cleans the workspace (`git clean -ffdx`), so `node_modules` and `.venv` are
  rebuilt from those caches on every job, which is what keeps one job's
  leftovers out of the next.
- **`adapt-fork` is sharded by position.** `--shard=K/N` keeps every N-th answer
  set from the K-th, so a set added to `ANSWER_SETS` lands in a leg without the
  matrix changing. A leg past the last set logs that and passes.

## Provisioning

`provision.sh`, beside this file, sets up the machine from a fresh Ubuntu
Server: Docker, a `runner` user in the `docker` group with no sudo, Chromium's
system packages through `npx playwright install-deps`, the runner instances as
systemd services, and a weekly `docker system prune` timer. It is safe to
re-run, and raising `RUNNERS` adds instances.

**`sudo` asks for a password there, so the script runs from a terminal of your
own, with one attached.** Piped into `ssh` it leaves `sudo` no terminal to ask
on. Copy it over first:

```sh
token=$(gh api -X POST repos/$R/actions/runners/registration-token --jq .token)
scp .claude/skills/ci-runner/provision.sh minipc:
ssh -t minipc "sudo RUNNER_TOKEN=$token bash ~/provision.sh"
```

The token lasts an hour and registers every instance. Type the last line rather
than pasting it from a rendered page: a pasted non-breaking space makes `ssh`
look up " minipc" and report "Could not resolve hostname".

Playwright 1.64.1's `install-deps` accepted Ubuntu 26.04. If a later one refuses
the machine's release, reinstall it with the release `ubuntu-latest` uses, which
also keeps the two environments alike. Twelve instances (the script's default,
`E2E_PORT` 8101 to 8112) cover one full run of twelve test jobs at once, and a
second run queues behind it, taking runners as the first frees them. With the
earlier six-job layout, re-runs of PR #65's and PR #64's CI started together
finished green in 2m03 and 3m36 with no port or container clash between the two.

To remove an instance (to rename it, or retire the machine):

```sh
token=$(gh api -X POST repos/$R/actions/runners/remove-token --jq .token)
# on the mini PC, in /home/runner/runner-N:
sudo ./svc.sh stop && sudo ./svc.sh uninstall
sudo -u runner ./config.sh remove --token "$token"
```

## Housekeeping

- Docker: `ci-docker-prune.timer` prunes weekly, so the `postgres:18` image is
  pulled again about once a week.
- `du -sh /home/runner/.cache/*` when the disk fills: uv, npm, Deno and
  Playwright keep every version they have fetched.
- `scripts/adapt_fork_check.ts` keeps a failed fork's copy under `/tmp`
  (`adapt-fork-*`); systemd-tmpfiles ages those out after ten days.
- The runners update themselves; unattended-upgrades covers the OS.
- SSH accepts keys only: `/etc/ssh/sshd_config.d/10-keys-only.conf` sets
  `PasswordAuthentication no`. Its name has to sort before cloud-init's
  `50-cloud-init.conf`, because sshd keeps the first value it reads and that
  file says `yes`.
