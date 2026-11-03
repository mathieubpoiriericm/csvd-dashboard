---
name: ci-runner
description: Use when CI jobs queue and never start, when moving CI between the home mini PC and GitHub's runners, after upgrading @playwright/test, when adding a job that serves on a port, or when provisioning, re-registering or cleaning up the self-hosted runners - the CI_RUNNER variable and its fallback, why the runners belong to the private repository alone, the per-runner E2E_PORT, and the machine's housekeeping.
---

# The self-hosted CI runners

The five test jobs in `.github/workflows/ci.yml` (`check`, `python`, `e2e`,
`empty-data`, both `adapt-fork` legs) run on
`${{ vars.CI_RUNNER || 'ubuntu-latest' }}`. The private repository
(`mathieubpoiriericm/csvd-dashboard-private`) has set the repository variable
`CI_RUNNER=csvd-ci` since 3 November 2026, which sends them to six runners,
`ryzen-1` to `ryzen-6`, on a dedicated mini PC at home: Ubuntu Server 26.04 on
bare metal, a Ryzen 9 9955HX (16 cores, 32 threads) with 32 GB, reached from the
researcher's Mac as `ssh minipc` with key login only. The public repository and
every fork have no such variable and stay on `ubuntu-latest`. `container` and
`deploy` are hosted everywhere.

The same CI run, PR #65's (41720801102), took 8m01 on GitHub's two-core private
runners and 2m20 on the mini PC -- its first jobs there, on cold caches -- with
every suite's pass and skip counts identical. Before the `adapt-fork` split a
push took about ten minutes (run 41546971078, 2 November 2026).

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

- **The runners are registered to the private repository and nowhere else.**
  The public repository takes pull requests from forks, and a self-hosted
  runner runs whatever code a pull request's workflow names. A runner
  registered there would hand the machine to anyone who opens one. The
  variable is only the selector; the registration is the boundary.
- **No job may take a fixed host port.** On GitHub's runners every job has a VM
  of its own; here six share one. The postgres services publish on a free port,
  read back through `job.services.postgres.ports['5432']` into
  `CSVD_TEST_DB_URL` (in a step, because the `job` context is not available in
  a job's `env`). Each runner's `.env` sets `E2E_PORT=810N`, which
  `e2e/playwright.config.ts` serves the build on. A new job that serves on a
  port, or a fixed container name or image tag like the `container` job's,
  either follows suit or stays on `ubuntu-latest`.
- **After upgrading `@playwright/test`, re-run the provisioning script with the
  new `PLAYWRIGHT_VERSION`.** The workflow passes `--with-deps` only on
  GitHub's runners, because a self-hosted one has no sudo. A newer Chromium
  needing a package the machine lacks fails to launch, with Playwright's "Host
  system is missing dependencies" or a missing `.so`.
- **Every action in `ci.yml` runs on `node24`**, the newest runtime GitHub
  offers actions (`astral-sh/setup-uv` was the last on `node20`, until it moved
  to `v10.3.3` on 2026-11-03; it publishes exact versions only, so there is no
  `v10` tag to float on). A self-hosted runner too old for `node24` fails every
  job at its first action, so keep the runners updating themselves. The tests
  themselves run on Node 26, from `actions/setup-node`'s `node-version: 26`.
- **Caches live on the machine's disk.** `setup-uv` and `setup-node` cache through
  GitHub's service only on hosted runners; here uv, npm, Deno and Playwright
  keep their caches under `/home/runner`. `actions/checkout` still cleans the
  workspace (`git clean -ffdx`), so `node_modules` and `.venv` are rebuilt from
  those caches on every job, which is what keeps one job's leftovers out of
  the next.
- **`adapt-fork` is sharded by position.** `--shard=K/N` keeps every N-th
  answer set from the K-th, so a set added to `ANSWER_SETS` lands in a leg
  without the matrix changing. A leg past the last set logs that and passes.

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
also keeps the two environments alike. Six instances on 32 threads cover one
full run (six jobs, two of them the `adapt-fork` legs) at once, and a second
run queues behind it: re-runs of PR #65's and PR #64's CI started together
finished green in 2m03 and 3m36, the second's jobs taking runners as the
first's freed them, with no port or container clash between the two.

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
